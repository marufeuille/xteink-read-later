# GitHub merge gates

AGENTS.md の自律マージを、GitHub 側でも強制する。運用の正本は `.github/merge-gates/main-ruleset.json` と `.github/workflows/ci.yml`。

## なぜ public か

このリポジトリは個人アカウントの GitHub Free 上にある。private のままだと ruleset も classic の branch protection も API が 403 になり、`main` への直接 push を止められない。

- 秘密値は GitHub Actions secrets と Cloudflare secrets に残し、リポジトリには置かない
- 復旧は `gh repo edit marufeuille/xteink-read-later --visibility private`
- GitHub Pro に上げて private のまま保護する選択もある

## 強制していること

- `main`（default branch）への直接 push / force push / 削除を禁止する
- bypass リストは空。管理者も迂回できない
- 変更は pull request 経由。人間の Approve は必須にしない（自律マージ用）
- 未解決のレビュースレッドがあるとマージできない
- 必須チェックは `merge-gate` だけ。発行元は GitHub Actions（App ID `15368`）
- `merge-gate` は `typecheck, unit, e2e` が `success` のときだけ成功する。失敗・キャンセル・スキップは失敗にする
- workflow 全体が未実行（`[skip ci]` など）だと必須チェックが pending のまま残り、マージできない
- GitHub Actions の GITHUB_TOKEN は `contents: read`。PR レビューの自己承認は不可

## 最新 main との組合せ

複数エージェントが同時に PR を出す前提なので、利用できるなら merge queue を使う。queue は最新 `main` との合成に対して `merge_group` で `merge-gate` を再実行し、`ALLGREEN` なので失敗した PR は落ちて止まる。

merge queue が個人リポジトリで使えない場合は、required status checks の up-to-date（strict）に落とす。その場合は PR を最新 `main` に合わせてからマージする。

自動マージ経路はリポジトリの auto-merge。条件を満たした PR で `gh pr merge --auto` する。チェックが失敗または未報告ならマージされない。

## 適用と確認

CI の `merge_group` と `merge-gate` が `main` に入ったあと、管理者権限で一度だけ:

```bash
bash .github/scripts/apply-merge-gates.sh --make-public
bash .github/scripts/verify-merge-gates.sh
```

すでに public なら `--make-public` は不要。スクリプトは ruleset を作り、だめなら merge queue なし、それもだめなら classic protection（`enforce_admins`）へ落とす。auto-merge と「Actions は PR を approve できない」も同時に設定する。

失敗して止まることの確認:

```bash
git push origin HEAD:main
# protected branch で拒否される

# テストを壊した PR を開き、CI 後:
gh pr merge --auto --merge
# merge-gate が success でないため auto-merge は完了しない
```

復旧: ruleset `main-merge-gates` を GitHub の Settings → Rules → Rulesets から削除するか `enforcement: disabled` にする。classic protection を使った場合は `main` の protection を外す。公開範囲を戻すなら visibility を private にする（その時点で Free では保護できなくなる）。

## PR リスク分類の試行

`pr-risk-trial`（`.github/workflows/pr-risk.yml`）は判定を記録するだけ。必須チェックにしない。`merge-gate` の `needs` にも足さない。本運用の足し方は `docs/pr-risk.md` と次の節。

## 高リスク AI レビューを後から必須にする

認証・秘密情報・削除・CI / デプロイ設定など、AGENTS.md の高リスク変更向け。

1. workflow にジョブを足す。`name` を安定させる（例: `high-risk-review`）。`continue-on-error` は付けない。
2. そのジョブを GitHub Actions で走らせ、一度 success を出す。
3. `.github/merge-gates/main-ruleset.json` の `required_status_checks` に `{ "context": "high-risk-review", "integration_id": 15368 }` を足す。これが必須化の本体。
4. skip を success にしたくない場合は、`merge-gate` の `needs` に足すだけでなく、そのジョブの `result` も `success` 必須にする。`needs` だけ足しても `merge-gate` は今も `needs.check.result` しか見ない。
5. `bash .github/scripts/apply-merge-gates.sh` を再実行する。

チェック名を変えたら ruleset も同時に更新する。bypass actor は足さない。Actions の `can_approve_pull_request_reviews` は on にしない。書き込み権限のある主体が PR の workflow で同名ジョブを空成功に差し替える余地は、個人リポジトリでは残る。org の required workflows が使えるようになったらそれを足す。
