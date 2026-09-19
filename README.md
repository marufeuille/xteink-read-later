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

1 リクエストで fetch → 抽出 → 言語判定 → 翻訳/整形 → EPUB 生成まで走る。成功時は `status: "ready"` と `epubPath`、`timingsMs` を返す。EPUB とメタデータは R2（`wrangler dev` ではローカルシミュレーション）へ保存する。同一 canonical URL の再送は同じ `id` で上書きし、`createdAt` は初回のまま `updatedAt` だけ更新する。

```bash
curl -sS -o clip.json http://localhost:8787/clip \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
curl -sS -o book.epub "http://localhost:8787$(jq -r .epubPath clip.json)"
curl -sS -X DELETE "http://localhost:8787/articles/$(jq -r .id clip.json)"
```

手動削除は `DELETE /articles/:id`。存在しない id は 404。

OPDS 1.2 相当の Atom カタログは `GET /opds`。新しい記事が上で、各 entry の `http://opds-spec.org/acquisition` リンクから EPUB を取る。CrossPoint JP にはこの URL を登録する（HTTP Basic は MAR-38）。

```bash
curl -sS http://localhost:8787/opds
curl -sS -o book.epub "http://localhost:8787/opds/download/$(jq -r .id clip.json).epub"
```

ログは stage 別の JSON（`fetch` / `extract` / `translate` / `epub` / `store`）で所要時間と失敗 `errorKind` を出す。

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

`npm test` は単体テストと、fixture + OpenAI モックの E2E を実行する。実 `OPENAI_API_KEY` もライブの記事取得も不要。

GitHub Actions が pull request と `main` への push で install / typecheck / 単体 / E2E を回す。**マージしてよい判断基準は CI が緑であること。**

任意のライブ E2E（実ネットワーク。英語記事は OpenAI が必要）はローカル限定:

```bash
E2E_LIVE=1 E2E_LIVE_URL='https://example.com/article' npm run test:e2e:live
```

## Cloudflare Workers へデプロイ

同じ `src/` を `wrangler deploy` する。Workers Paid を前提（`limits.cpu_ms = 30000`）。秘密情報はソースに置かず Workers Secret にする。R2 バケット `xteink-read-later-articles` がアカウントに必要。

```bash
npx wrangler login
npx wrangler r2 bucket create xteink-read-later-articles
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CLIP_TOKEN
npx wrangler secret put OPDS_USERNAME
npx wrangler secret put OPDS_PASSWORD
npm run deploy
```

デプロイ後:

```bash
curl -sS https://xteink-read-later.<account>.workers.dev/clip \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
```

ログは stage / durationMs / errorKind のみ。token や記事全文は出さない。
