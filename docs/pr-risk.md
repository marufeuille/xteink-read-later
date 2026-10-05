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
| auth | `src/http/auth.ts`, `src/http/clip-web-auth.ts`, `src/http/access-identity.ts`, `src/http/candidate-session.ts`, `test/auth.test.ts`, `test/access-identity.test.ts` |
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

過去 PR の再判定は記録のみ。マージ条件は変えない。

手元:

```bash
GITHUB_TOKEN=$(gh auth token) OPENROUTER_API_KEY=… npm run pr-risk:replay -- --limit 20
GITHUB_TOKEN=$(gh auth token) OPENROUTER_API_KEY=… npm run pr-risk:replay -- --pr 7,10,13,31,34,35
```

Actions（リポジトリ secret の `OPENROUTER_API_KEY`。成果物は artifact `pr-risk-replay` 内の `pr-risk-replay.jsonl`）:

```bash
gh workflow run "PR risk trial" -f prs=7,10,13,14,18,21,31,33,34,35,36,39,40
```

キーが無いときはすべて `jev_skipped` で追加レビューになる（低リスクにはしない）。

## 本運用へ移す条件

必須チェックにはまだしない。任意の追加レビュー `high-risk-review` は下の節（[MAR-69](https://linear.app/marufeuille/issue/MAR-69)）。次をすべて満たすのは、それを必須にする前の条件（[MAR-61](https://linear.app/marufeuille/issue/MAR-61)。手順は `docs/github-merge-gates.md`）である。

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
npm run pr-risk:review -- --no-comment
```

## 高リスク追加レビュー（MAR-69）

分類の記録とは別に、high と判定した PR だけ OpenRouter の Sol 級モデルで追加レビューする。**必須チェックではない。** `merge-gate` の `needs` にも ruleset にも入っていない。指摘は PR の会話コメントに残すだけで、レビュースレッドは作らない。未解決のレビュースレッドがあるとマージできないため、行コメントにはしない。マージ権限はない。`pull_request_target` は使わない。

ジョブ名は `high-risk-review`（`.github/workflows/pr-risk.yml`）。`pr-risk-trial` が成功した `pull_request` の `opened` / `synchronize` / `reopened` / `ready_for_review` だけで走る。本文やタイトルの `edited` では workflow 自体を走らせない。

費用上限 US$0.30 は、API を呼ぶその 1 回の見積もり上限である。head SHA の累計ではない。同じ head SHA で、`github-actions[bot]` が書いた会話コメントにその SHA の呼び出し記録（`<!-- high-risk-review sha=` と「API を呼んだ」）があるときは、もう呼ばない（[MAR-182](https://linear.app/marufeuille/issue/MAR-182)）。人が同じ印を貼っても、そのコメントは呼び出し記録にしない。人のコメントは書き換えず、`github-actions[bot]` のコメントが無ければ新しく書く。呼び出し記録のあるコメントは上書きしない。同じ SHA のあとの run がオフや対象外で終わっても、その記録は置き換えない。会話コメントは 1 ページ 100 件で、最大 10 ページまで読む。新しいコミットは head SHA が変わるので、high ならもう一度呼び、`github-actions[bot]` のコメントをその SHA の結果で置き換える。判定ファイルの head SHA がイベントの head SHA と違うときも、古い結果は無効として API を呼ばない。

### high とみなす条件

既存の判定 JSON の `blockers` だけを見る。`recommendedRoute === additional_review` では呼ばない。

次のどちらかがあるときだけ high。

| blocker | 意味 |
| --- | --- |
| `hard_rule` | 固定ルール（auth / secrets / ci_deploy / judgment_rules / data_lifecycle）に当たった |
| `jev_high` | `change_risk = high` かつ信頼度が 0.85 以上 |

`change_risk = high` でも信頼度が 0.85 未満なら blocker は `low_confidence` であり、`jev_high` ではない。これは対象外。

次だけの `additional_review` は **対象外**。API は呼ばず、コメントと artifact に対象外と書く。文書や CLI が fail-safe で追加レビューになる経路はここ。

- `incomplete_input`（diff が無い、切り詰めた、ファイル数の上限）
- `jev_skipped`（分類側のキー無し）
- `jev_failed`（分類 API の失敗や、形の違う応答）
- `low_confidence`
- `noul_high`（Noul が 0.4 以上）

低リスク候補（`blockers` が空）も対象外。

workflow の replay 既定 13 件（#7, #10, #13, #14, #18, #21, #31, #33, #34, #35, #36, #39, #40）を、MAR-68 の replay（[Actions run 35505906619](https://github.com/marufeuille/xteink-read-later/actions/runs/35505906619)、`hard_rule=9`、`low_risk=1`）の blockers で見ると、`hard_rule` または `jev_high` は **9 件**（#7, #10, #13, #14, #18, #31, #33, #35, #39）である。残り 4 件は対象外で API は呼ばない。#21、#34、#40 は fail-safe だけ（`low_confidence` や `noul_high`、一部は `incomplete_input`）。#36 は低リスク候補。`additional_review` の 12 件全部は呼ばない。

### モデル、単価、上限

| 項目 | 内容 |
| --- | --- |
| モデル | `openai/gpt-6.1-sol` |
| 単価の出典 | [GPT-6.1 Sol on OpenRouter](https://openrouter.ai/openai/gpt-6.1-sol)（2026-10-05 確認） |
| 入力 | US$2.00 / 100万トークン（1トークン US$0.000002） |
| 出力 | US$10.00 / 100万トークン（1トークン US$0.00001） |
| 1 回の上限 | US$0.30（この呼び出しの見積もり。head SHA の累計ではない） |
| `max_tokens` | 2048 |
| reasoning | `effort: low`（このモデルは reasoning が必須で、対応する最も低い effort。既定は medium） |
| 同じ SHA | `github-actions[bot]` がその SHA で API を呼んだコメントがあるときだけ、もう呼ばない |
| 呼び出し | 通信のリトライはしない |

同じ公開単価（入力 US$2 / 100万、出力 US$10 / 100万）の Sol 級には `openai/gpt-5.6-sol` と `openai/gpt-6-sol` もある。コーディング向けの新しい `openai/gpt-6.1-sol` を選んだ。`openai/gpt-5.6-sol-pro` はトークン単価が同じでも reasoning が増え、上限に当たりやすいので使わない。

呼ぶ前の見積もりは `入力トークン × 0.000002 + max_tokens × 0.00001`。入力トークンは、送る文字列を 1 文字 1 トークンと見なし（日本語の diff でも上限を超えない側に倒す）、メッセージ枠として 32 を足した数。見積もりが US$0.30 を超えるときは diff を短くして再計算する。パスと固定プロンプトだけでも超えるときは呼ばず、理由を残す。cache write（US$2.50 / 100万トークン）はこの見積もりに入れていない。OpenRouter が入力をキャッシュへ書くと、その分は別料金になる。

2048 トークンの出力は US$0.02048。残り US$0.27952 が入力に使えるので、この見積もりではおおよそ 14 万文字まで送れる。それを超える diff は打ち切る。

応答後の概算は、API が返した入力・出力トークンに同じ単価を掛けたもの。artifact `high-risk-review.json` と PR コメントに、モデル名、入出力トークン、概算、head SHA を書く。

### 送るもの

変更パスと、切り詰めて伏せ字にした diff だけ。PR 本文、secret の値、環境変数は送らない。`OPENROUTER_API_KEY` は既存の Actions secret を使う。新しい secret は足さない。

### オフ

リポジトリの **Settings → Secrets and variables → Actions → Variables** に `HIGH_RISK_REVIEW` を作り、値を `off` にする。これだけで止まる。ruleset の再適用は要らない。`merge-gate` も触らない。

未設定や空はオン。`off`（大文字小文字は無視し、前後の空白も無視する）はオフ。オフでも、キーが無くても、ジョブは失敗にしない。API は呼ばない。

キーは分類と同じ `OPENROUTER_API_KEY`。無いときはレビュー API を呼ばず成功する。

### 指摘

指摘には箇所（パス）と、diff にある根拠を書く。根拠のある指摘が無ければ、その旨を head SHA 付きで書く。モデル出力が空のとき、指摘の JSON として読めないとき、または JSON としては読めても指摘が全部無効（箇所か根拠が空、または形が違う）で捨てられたときは「指摘はありません」にはしない。空ならその旨、読めなければ読めなかった旨を head SHA 付きで書く。有効な指摘が残ったときは、無効なものを捨てて残りを記録する。API が失敗してもジョブは成功のままにし、失敗したことと head SHA を残す。
