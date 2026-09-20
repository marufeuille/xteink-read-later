# MAR-44: 翻訳モデルの焼比べと決定

対象: [MAR-44](https://linear.app/marufeuille/issue/MAR-44/翻訳をdeeplまたは専用モデルに切り替え検討)

調査日: 2026-09-20。料金は同日の公式ページ。本番の翻訳契約（Markdown JSON、コード保持、要約しない）は変えない。

## 決定

1. **読書向け整形は残す。** DeepL 単体は採用しない。
2. **本番モデルは `gpt-4o-mini` から `gpt-4.1-mini` に上げる。** プロンプト、Chat Completions URL、`OPENAI_API_KEY` はそのまま。
3. **PLaMo 3.0 Prime は次点。** OpenAI 互換だが Secret・`json_schema`・`max_tokens` が要る。ライブ比較は `.dev.vars` に `PLAMO_API_KEY` を置いて `npm run translate:bakeoff`。
4. **DeepL、DeepL+LLM 二段、`plamo-2-translate` 自前ホスト、gpt-4o は採用しない。** `gpt-5.6-luna` は日本語品質で勝てば差し替えてよい（同じ `OPENAI_API_KEY`。`temperature` は送らない）。

## 現行が gpt-4o ではなかった

[`src/translate/constants.ts`](../../src/translate/constants.ts) の既定は `gpt-4o-mini` だった。チケット文面の「翻訳専用／安い LLM」がすでに本番である。知識カットオフは 2023-10-01。不自然な日本語の主因はカットオフより **mini 階級** の方が大きい。

`gpt-4.1-mini` のカットオフは 2024-06-01。2026-09 時点でも新しい固有名詞の保証にはならないが、reasoning なし・指示追従が強く、60 秒 abort と Queue 再試行と相性が良い。

## コーパス（固定）

原文 HTML は `test/fixtures/translate-bakeoff/`。契約は `src/translate/bakeoff-corpus.ts`。単体テストが Markdown 化後もコードフェンス・見出し・リンク・非翻訳トークンが残ることを固定する。

| id | ねらい | 2026 固有名詞 |
| --- | --- | --- |
| `workers-compat` | コード、`compatibility_date`、見出し | `2026-09-19` |
| `durable-objects` | Durable Objects SQLite、リスト、リンク | `gpt-4.1-mini`, `GPT-5.6` |
| `hedging-prose` | 直訳しやすいイディオムとですます混在 | （なし。文体用） |
| `jp-llm-wave` | PLaMo 3.0 Prime / Sakana Namazu | モデル名そのもの |

ライブ実行は `.dev.vars` またはシェルの `OPENAI_API_KEY` / `PLAMO_API_KEY` を付けて `npm run translate:bakeoff`。通常の `npm test` では呼ばない。結果の見方は末尾の「再計測」。

## ライブ結果（2026-09-20、この Cloud Agent 環境）

`npm run translate:bakeoff` は 12 件ともキー未設定で skip した。

- OpenAI 2 モデル × 4 記事: `OPENAI_API_KEY is not set`
- PLaMo × 4 記事: `PLAMO_API_KEY is not set`

品質・実測レイテンシ・実測トークンはこの環境では取れない。再実行したら JSON の `durationMs` / `scores.missingKeepTokens` / `estimatedUsd` / `contentExcerpt` をこの節に追記する。

## 公開情報からの比較（キー無しでも決める材料）

| 候補 | 統合 | カットオフ / 鮮度 | 60s との相性 | 記事あたり費用目安 | 整形契約 |
| --- | --- | --- | --- | --- | --- |
| gpt-4o-mini（現行） | そのまま | 2023-10 | 良い | 入力 $0.15 / 出力 $0.60 per 1M | 今のプロンプト |
| gpt-4.1-mini（採用） | `model` 差し替え | 2024-06 | 良い（reasoning なし） | 入力 $0.40 / 出力 $1.60 per 1M | 今のプロンプト |
| gpt-5.6-luna | 同じ `OPENAI_API_KEY`。`temperature` 禁止、`reasoning_effort=none` | 2026-02 | nano 寄り。reasoning を none にしないと 60s を食いやすい | 入力 $0.20 / 出力 $1.20 per 1M | JSON は流用可 |
| plamo-3.0-prime | 新 Secret、`json_schema`、`max_tokens` 明示 | 2026-06 正式 | reasoning は必ず `none`。既定 `max_tokens` 4096 は長文で切れる | 入力 60 円 / 出力 250 円 per 1M | プロンプトは流用可 |
| sakana-namazu | 任意。thinking 既定オン | 日本語特化 | thinking オフ必須 | 従量 | OpenAI 互換 |
| DeepL | HTML `tag_handling`。Markdown 非ネイティブ | MT なのでカットオフ概念が違う | 速い | 2026 新規は Growth 月額フロア | 初出併記・整形なし |

個人利用ではトークン差は Workers Paid 月 $5 より小さい。gpt-4.1-mini は現行 mini の数倍だが、記事 1 本あたり数円以下。

PLaMo を今採用しない理由: ライブ品質が未計測なのに Secret とレスポンス形式を増やすと、失敗時の Queue リトライ（`translate_failed`）が増えるリスクを検証できない。同ベンダーの model 差し替えなら失敗面は現行と同じ。

## 採用後の契約

- 英語など `non-ja` は全文を自然な日本語 Markdown にする（要約しない）
- コード・CLI・API 名・固有名詞は原文
- 専門用語は初出のみ英語併記してよい
- 日本語記事は API を呼ばない
- モデル title は捨て、抽出 title を使う
- 失敗は `translate_failed`。抽出結果は job HTTP には出さない（現行どおり）

## 再計測

```bash
npm run translate:bakeoff
```

`.dev.vars` の `OPENAI_API_KEY` / `PLAMO_API_KEY` で足りる。確認は次の3軸。

1. **速度:** stdout 表の平均・最大 `durationMs`。60 秒超は落す。
2. **コスト:** 建値（USD または円）と 150 円/$ の換算列。記事 4 本合計。
3. **自然さ:** `hedging-prose/<model>.md` を先に読む。表の「未翻訳」は原文コピー（日本語比率が極端に低い）。keep token が全部当たっていても翻訳成功ではない。PLaMo には英語の title/content JSON をそのまま返させないアダプタを使う。

`contentExcerpt` は先頭 400 文字だけなので、自然さの判定には使わない。

PLaMo か Luna が自然さで明確に勝ち、かつ 60 秒以内なら、その時点で差し替え PR を切る。二段翻訳はしない。
