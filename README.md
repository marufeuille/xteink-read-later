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

成功時は title / author / publishedAt / canonicalUrl / contentHtml / translated を JSON で返す。英語記事は OpenAI で日本語化し、日本語記事は再翻訳しない。失敗時は `error.code` と `error.message` で原因を返す。翻訳失敗時（503）は `error.extracted` に抽出結果を残す。

`.dev.vars` の `OPENAI_API_KEY` を使う（リポジトリには入れない）。

| 状態 | 意味 |
| --- | --- |
| 400 | URL 不正 |
| 413 | 取得 HTML が上限超過 |
| 422 | 本文を抽出できない |
| 502 | 対象ページの取得失敗 |
| 503 | 翻訳失敗（抽出結果は `error.extracted`） |

## テスト

```bash
npm test
npm run typecheck
```
