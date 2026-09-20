# PR リスク分類（MAR-60）

低リスク変更を速く通し、高リスク変更は追加レビューへ振り分けるための **試行**。記事分類（MAR-57）とは別。**判定は記録するだけ**で、マージ権限も必須チェックにもしない。

## 利用可否・API・費用・送信範囲

試行は記事分類と同じ **OpenRouter Decisions API**（`POST /api/alpha/decisions`、モデル `typesafe/jev-1.13`）。

| 項目 | 内容 |
| --- | --- |
| 公式 API | `POST https://api.typesafe.ai/v1/systemone`。early access。リクエスト形 `{ state, questions }` は同じ |
| 今回使う経路 | OpenRouter。入金済みですぐ使える。実体は TypeSafe Jev |
| 価格 | 入力 $0.042 / MTok、出力無料。PR 1件あたり数千〜2万トークン程度なら $0.001 未満 |
| 型 | Choice / Noul。確率と（Choice は）信頼度。型が合うことは正しさの保証ではない |
| タイムアウト | 8秒。失敗は追加レビュー |

送るもの（OpenRouter → TypeSafe）:

- 変更ファイルパス、テストファイルの印、切り詰めた diff、PR タイトル / 本文、Linear ID、本文から取った受け入れ条件
- 秘密値っぽい文字列は `[REDACTED]`
- リポジトリ全文、Cloudflare / GitHub の secret 値、未切り詰めの巨大 diff は送らない

データ利用:

- TypeSafe: Input でモデルを学習・fine-tune しない（[Privacy policy](https://www.typesafe.ai/privacy)）
- OpenRouter: 自身は Input/Output を学習に使わない。モデル提供者（TypeSafe）へ推論のために転送する（[Privacy](https://openrouter.ai/privacy)）

このリポジトリは public。それでも diff は切り詰め、secret 値は伏せる。

## 入力と質問

入力は `untrusted_input` に閉じる。PR 本文・差分の命令は判定ルールにしない。質問はコードの `PR_RISK_QUESTIONS` だけ。

| 質問 | 型 | 使い方 |
| --- | --- | --- |
| `change_risk` | Choice `low` / `high` | 全体のリスク。不明なら high |
| `touches_auth` | Noul | 認証・認可 |
| `touches_secrets` | Noul | 秘密情報 |
| `touches_data_lifecycle` | Noul | 永続データの削除・移行 |
| `touches_ci_deploy_rules` | Noul | CI / デプロイ / 判定ルール |

コード側で合成する。Jev にマージ可否は聞かない。

## 固定ルール（格下げしない）

次のパスは Jev が `low` かつ信頼度 1.0 でも **追加レビュー**。

| 理由 | パス |
| --- | --- |
| auth | `src/http/auth.ts`, `test/auth.test.ts` |
| secrets | `.dev.vars*` / `.env*`（ディレクトリ内も含む）、`secret` / `credential` ファイル |
| ci_deploy | `.github/**`, `wrangler.jsonc` |
| judgment_rules | `AGENTS.md`, `docs/pr-risk.md`, `docs/github-merge-gates.md`, `src/pr-risk/**`, `src/types/pr-risk.ts`, `test/pr-risk*.test.ts` |
| data_lifecycle | パスに `migrat` / `migrations/` |

rename / copy は **旧パスも**見る。`src/http/auth.ts` を別ファイルへ移しても auth のまま。永続データの削除のうちパスに現れないものは Jev の `touches_data_lifecycle` に任せる。noul が低ければ見逃しになり得るので、試行中は人間ラベルと突き合わせる。

Linear の受け入れ条件は試行では PR 本文（と検出した `MAR-*`）を使う。Linear API は呼ばない。

## 追加レビューにする条件

次のいずれかで `recommendedRoute = additional_review`。自動で低リスクにしない。

- 差分が無い、または切り詰めた（本文・Linear・diff・ファイル数）
- 固定ルールに当たった
- `OPENROUTER_API_KEY` 未設定（`jev_skipped`）
- HTTP 失敗・タイムアウト・形が違う応答
- `change_risk` の信頼度が **0.85 未満**
- `change_risk = high`
- いずれかの Noul が **0.4 以上**

低リスク候補は、上をすべて免れ、かつ `change_risk = low` のときだけ。試行中のアクションは常に `record_only`。

## 記録と再判定

GitHub Action `pr-risk-trial` が PR の open / synchronize / 本文編集で走る。

記録するもの:

- 対象 SHA（head / base）
- 入力範囲（ファイル、diff 字数、truncated / missingDiff、Linear ID）
- ルール版 `pr-risk-v1`、モデル名
- 固定ルール、Jev の確率・信頼度、blockers、推奨ルート

成果物は PR コメント（同じスレを SHA ごとに更新）と artifact `pr-risk-judgment.json`。追加コミットでは head SHA が変わるので再判定する。

この workflow は **必須チェックにしない**。`merge-gate` からも外す。失敗しても main のマージ条件は変わらない。

`pull_request` では GitHub が PR 側の workflow / 分類器を実行する。`pull_request_target` は使わない（secret を PR コードへ渡す）。判定ルールを弱めた PR の自己判定は信用しない。それ以外の PR は、分類器を触らなければ main と同じルールで記録される。

空の diff、git 取得失敗、GitHub の files が 1000 件で打ち切られた場合は `incomplete_input` / truncated として追加レビューにする。replay の files は最大 10 ページ（1000 件）取り、打ち切ったら incomplete にする。

## 試行の見方

人間ラベル（AGENTS.md の高リスク定義）と、固定ルール + Jev の推奨ルートを比べる。

| PR | 人間ラベル | 主な理由 |
| --- | --- | --- |
| #7 | 追加レビュー | CI |
| #10 | 追加レビュー | 認証 |
| #13 / #14 | 追加レビュー | デプロイ |
| #18 | 追加レビュー | 認可 |
| #21 | 低リスク候補 | 文書 |
| #31 / #33 | 追加レビュー | 判定・マージ方針 |
| #34 | 低リスク候補 | CLI（認証値は扱うが Worker 認証は変えない） |
| #35 | 追加レビュー寄り | secret 名と Jev 導入。固定ルールには必ずしも当たらない |
| #36 | 低リスク候補 | 比較ドキュメント |

見逃し = 人間が高リスクなのに `low_risk`。固定ルール対象で `low_risk` になった件数は `hard_rule_misses`。これは **0 でなければ本運用しない**。

過去 PR の再判定:

```bash
GITHUB_TOKEN=$(gh auth token) OPENROUTER_API_KEY=… npm run pr-risk:replay -- --limit 20
GITHUB_TOKEN=$(gh auth token) OPENROUTER_API_KEY=… npm run pr-risk:replay -- --pr 7,10,13,31,34,35
```

キーが無いときはすべて `jev_skipped` で追加レビューになる（低リスクにはしない）。

## 本運用へ移す条件

まだ必須チェックにも追加レビューの自動依頼にもしない。次をすべて満たしたら、別チケットで `high-risk-review` を足す（手順は `docs/github-merge-gates.md`）。

1. 実 PR を **20 件または 4 週間** 記録した
2. `hard_rule_misses` が 0 のまま
3. 人間ラベルが高リスクの PR を `low_risk` にした件が 0（固定ルール外の意味的な高リスクも含む）
4. 閾値 0.85 / 0.4 を動かすなら、その版で再判定し、見逃しが増えていない
5. 低リスク候補でも CI 必須チェックと AGENTS.md のマージ条件は残す。リスク分類は振り分けにだけ使う

閾値を緩めて低リスクを増やすより、見逃しを 0 に近づける。Jev が低リスクと言っても固定ルールは格下げしない。

## 運用

GitHub Actions secret に `OPENROUTER_API_KEY` を足す（Worker 用の Cloudflare secret とは別。Actions からは見えない）。未設定でも workflow は記録し、推奨ルートは追加レビュー。

ローカル:

```bash
npm run pr-risk:github -- --no-comment
npm run pr-risk:replay -- --pr 31
```
