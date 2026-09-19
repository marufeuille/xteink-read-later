# Xteink Read Later

個人利用向けの記事クリップパイプライン。Web 記事 URL を受け取り、本文を抽出して Xteink で読む EPUB にする。

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`wrangler dev` は既定で `http://localhost:8787` を開く。

### 本文抽出（MAR-30）

```bash
curl -sS http://localhost:8787/clip \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
```

1 リクエストで fetch → 抽出 → 言語判定 → 翻訳/整形 → EPUB 生成まで走る。成功時は `status: "ready"` と `epubPath`、`timingsMs` を返す。EPUB はメモリ上に置き、次で取得する。

```bash
curl -sS -o book.epub "http://localhost:8787$(jq -r .epubPath clip.json)"
```

ログは stage 別の JSON（`fetch` / `extract` / `translate` / `epub`）で所要時間と失敗 `errorKind` を出す。

英語記事は OpenAI で日本語化し、日本語記事は再翻訳しない。失敗時は `error.code` と `error.message` で原因を返す。翻訳失敗時（503）は `error.extracted` に抽出結果を残す。

`.dev.vars` の `OPENAI_API_KEY` を使う（リポジトリには入れない）。

| 状態 | 意味 |
| --- | --- |
| 400 | URL 不正 |
| 404 | 記事が無い |
| 413 | 取得 HTML が上限超過 |
| 422 | 本文を抽出できない |
| 502 | 対象ページの取得失敗 |
| 503 | 翻訳失敗（抽出結果は `error.extracted`） |

## テスト

```bash
npm test
npm run typecheck
```
