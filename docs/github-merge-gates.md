# GitHub merge gates

GitHub が `main` で強制するのは、pull request と必須チェック `merge-gate` である。PM の内容検品は GitHub では見ていない。クラウドエージェントは `merge-gate` が緑でもマージしない。誰がマージしてよいかは [AGENTS.md](../AGENTS.md) と、この文書の「マージしてよいとき」。機械的な正本は `.github/merge-gates/main-ruleset.json` と `.github/workflows/ci.yml`。

## なぜ public か

このリポジトリは個人アカウントの GitHub Free 上にある。private のままだと ruleset も classic の branch protection も API が 403 になり、`main` への直接 push を止められない。

- 秘密値は GitHub Actions secrets と Cloudflare secrets に残し、リポジトリには置かない
- 復旧は `gh repo edit marufeuille/xteink-read-later --visibility private`
- GitHub Pro に上げて private のまま保護する選択もある

## 強制していること

- `main`（default branch）への直接 push / force push / 削除を禁止する
- bypass リストは空。管理者も迂回できない
- 変更は pull request 経由。人間の Approve は GitHub の必須にしない。Masahiro にマージ承認は求めない
- 未解決のレビュースレッドがあるとマージできない
- 必須チェックは `merge-gate` だけ。発行元は GitHub Actions（App ID `15368`）
- `merge-gate` は分類ジョブ `classify changes` が `success` で、`typecheck, unit, e2e`（ジョブ `check`）と `simulator images`（ジョブ `simulator-images`）がそれぞれ `success` またはパス分類による `skipped` のとき成功する。失敗とキャンセルは失敗にする。必須チェック名は `merge-gate` のままなので、このスキップ方針に ruleset の再適用は要らない
- `simulator images` は画像レンダリングに関係する差分があるとき `npm run simulator:images` を実行する。対象パスは下の「変更パスによるスキップ」。実行時は upstream CrossPoint のピン止め SHA を `simulator_x3` でビルドし、デコードはネイティブ JPEGDEC（`CROSSPOINT_SIM_USE_NATIVE_DECODERS`）。SDL2 と OpenSSL を使い、`DISPLAY` が無いときは `xvfb` で起動する。帯の判定はその BMP を見る。ジョブは `check`（10 分）とは別で、上限は 45 分
- workflow 全体が未実行（`[skip ci]`、`on.paths`、`on.paths-ignore`）だと必須チェックが pending のまま残り、マージできない。スキップはジョブの `if` に置く
- GitHub Actions の GITHUB_TOKEN は `contents: read`。PR レビューの自己承認は不可

## 変更パスによるスキップ

重いジョブは、変更パスがすべてそのジョブのスキップ対象のときだけ `if` で skipped にする。正本は `.github/scripts/ci-changed-paths.sh`。判定は `pull_request` では base との three-dot、`merge_group` と通常の `push` ではその push / 合成コミットの two-dot。初回 push で `before` が全ゼロのときは追跡中の全ファイルを対象にする。

| ジョブ | skipped になる差分 | 実行する差分 |
| --- | --- | --- |
| `check`（typecheck, unit, e2e） | `docs/**` と、`src/`・`test/`・`simulator/` 以外の `*.md` だけ | それ以外。文書アサーションの `test/**` を含む |
| `simulator images` | 上に加え、`test/**`、`vitest.config.ts`、`vitest.e2e.config.ts`、`wrangler.*`、`migrations/**`、`infra/**`、`.github/scripts/**`、`.github/merge-gates/**`、`.github/workflows/pr-risk.yml`、`.github/workflows/access-terraform.yml`、`.dev.vars.example`、`.gitignore`、`.editorconfig`、`.nvmrc`、`.node-version` | `src/**`、`simulator/**`、`package.json`、`package-lock.json`、`vitest.simulator.config.ts`、`tsconfig.json`、`.github/workflows/ci.yml`、表に無いパス |
| `deploy worker` | docs、`test/**`、`simulator/**`、`ci.yml`、`pr-risk.yml`、`access-terraform.yml`、`.github/scripts/access-terraform.sh`、分類・merge-gate・ruleset 適用スクリプト、`infra/**`、`.github/merge-gates/**`、`.dev.vars.example`、`.gitignore`、`.editorconfig`、`.nvmrc`、`.node-version` | `src/**`、package manifests、`wrangler.*`、`tsconfig.json`、`migrations/**`、`.github/scripts/ensure-*.sh`、表に無いパス |

`src/**` は画像帯に効くファイルを切り分けず、simulator と deploy の両方の対象にする。表に無いパスは省略しない。

`deploy worker` は `main` への push だけで、`check` が `success` のとき走る。simulator がパス分類で skipped でも、Worker か deploy 設定に効く差分なら deploy する。`check` が失敗または skipped のときは deploy しない。docs だけの `main` マージでは deploy は skipped になる。

Access Terraform（`.github/workflows/access-terraform.yml`）は必須チェックではない。`on.paths` で `infra/access/**` と、その workflow、`.github/scripts/access-terraform.sh` だけを対象にする。無関係な PR では workflow 自体が走らない。必須チェックに足すときは `on.paths` を外し、スキップはジョブの `if` に移す。workflow が未実行だと、そのチェックは pending のまま残り、マージできない。この差分は simulator と `deploy worker` を走らせない。Workers の deploy は `CLOUDFLARE_API_TOKEN` のまま。Access Terraform は `TF_CLOUDFLARE_API_TOKEN`。手順は [access-as-code.md](access-as-code.md)。

`merge-gate` は `if: always()` なので、依存ジョブが skipped でも失敗でも実行される。`classify changes` が失敗したときはゲートも失敗する。GitHub はジョブの `if` による skipped を必須チェックの成功として扱う。GitHub がマージを受け付けるのは、常に実行する `merge-gate` の結論が `success` のときである。それだけでは、このリポジトリの手順としてマージしてよいことにはならない。条件は「マージしてよいとき」。

## 差分カバレッジ（表示のみ）

`diff coverage`（`.github/workflows/ci.yml` の `diff-coverage`）は、unit テストの行と分岐のカバレッジを取り、変更された `src/**/*.ts` のうち未実行の行と分岐をそのジョブの summary に書く。分類は `check` と同じ `needs.changes.outputs.check == 'true'` なので、docs だけの差分では skipped になる。skipped は `merge-gate` を落とさない。

このジョブは `merge-gate` の `needs` に入っていない。`continue-on-error: true` で、計測スクリプトも終了コード 0 で終わる。取得や表示が失敗しても `merge-gate` は落ちない。必須チェック名（`typecheck, unit, e2e`、`simulator images`、`merge-gate`）は変えていない。閾値は無い。外部サービスも追加の secret も使わない。

測り方と、測った全体の行・分岐、CI の所要時間の増分は [coverage.md](coverage.md)。

## 最新 main との組合せ

複数エージェントが同時に PR を出す前提なので、利用できるなら merge queue を使う。queue は最新 `main` との合成に対して `merge_group` で `merge-gate` を再実行し、`ALLGREEN` なので失敗した PR は落ちて止まる。

merge queue が個人リポジトリで使えない場合は、required status checks の up-to-date（strict）に落とす。その設定のときは、マージする前に PR を最新 `main` に合わせる。

## マージしてよいとき

`merge-gate` が成功していることだけではマージしない。CI が緑であることだけでもマージしない。

クラウドエージェント（Cursor の cloud agent と `cursor[bot]` を含む）は、マージ、squash、auto-merge をしない。`gh pr merge` と `gh pr merge --auto` は実行しない。PR を Ready for review で開いたら、そのエージェントの作業は終わる。

マージまたは squash してよいのは、次の両方が、その PR の現在の head について真のときだけである。

- 対応する Linear チケットのコメントに、文言 `PM 内容検品: **合格**` と、その PR の head SHA（16進で 40 桁）の両方が入っている。文言はこれと一致すること
- その同じ head で必須チェック `merge-gate` が成功している。失敗、キャンセル、未実行は成功にしない

head が変わったら、新しい 40 桁の SHA について内容検品と `merge-gate` をやり直す。前の head への合格コメントは、新しい head の合格にはならない。

Masahiro にマージ承認は求めない。

クラウドエージェント以外がマージするとき、リポジトリの auto-merge と merge queue は、上の両方が揃った head に対してだけ使ってよい。チェックが失敗または未報告なら、GitHub はマージを完了しない。クラウドエージェントは、条件が揃っていても `gh pr merge` と `gh pr merge --auto` を実行しない。

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

# テストを壊した PR で、ゲートが拒否することを見る例。
# クラウドエージェントが自分の PR をマージする手順ではない。
gh pr merge --auto --merge
# merge-gate が success でないため auto-merge は完了しない
```

復旧: ruleset `main-merge-gates` を GitHub の Settings → Rules → Rulesets から削除するか `enforcement: disabled` にする。classic protection を使った場合は `main` の protection を外す。公開範囲を戻すなら visibility を private にする（その時点で Free では保護できなくなる）。

## PR リスク分類の試行

`pr-risk-trial`（`.github/workflows/pr-risk.yml`）は判定を記録するだけ。必須チェックにしない。`merge-gate` の `needs` にも足さない。本運用の足し方は `docs/pr-risk.md` と次の節。

## 高リスク追加レビュー（任意）

`high-risk-review`（同じ workflow、[MAR-69](https://linear.app/marufeuille/issue/MAR-69)）は、判定が high の PR にだけ Sol 級モデルのレビューを残す任意ジョブである。`merge-gate` の `needs` にも、ruleset の必須チェックにも入っていない。止めるときは Actions の Variable `HIGH_RISK_REVIEW` を `off` にする。ruleset の再適用は要らない。条件と単価は `docs/pr-risk.md`。下の手順は、あとから必須にするとき（[MAR-61](https://linear.app/marufeuille/issue/MAR-61)）のもので、このジョブを足しただけでは行わない。

## 高リスク AI レビューを後から必須にする

認証・秘密情報・削除・CI / デプロイ設定など、AGENTS.md の高リスク変更向け。

1. workflow にジョブを足す。`name` を安定させる（例: `high-risk-review`）。`continue-on-error` は付けない。
2. そのジョブを GitHub Actions で走らせ、一度 success を出す。
3. `.github/merge-gates/main-ruleset.json` の `required_status_checks` に `{ "context": "high-risk-review", "integration_id": 15368 }` を足す。これが必須化の本体。
4. 新しい必須ジョブで skip を成功にしたくない場合は、`merge-gate` の `needs` に足すだけでなく、`.github/scripts/ci-merge-gate.sh` でその `result` を `success` 必須にする。`check` と `simulator-images` は `success` とパス分類の `skipped` を受け、`classify changes` は `success` だけを受ける。`needs` に足すだけでは、失敗したジョブを成功扱いのままにできる。
5. `bash .github/scripts/apply-merge-gates.sh` を再実行する。

チェック名を変えたら ruleset も同時に更新する。bypass actor は足さない。Actions の `can_approve_pull_request_reviews` は on にしない。書き込み権限のある主体が PR の workflow で同名ジョブを空成功に差し替える余地は、個人リポジトリでは残る。org の required workflows が使えるようになったらそれを足す。
