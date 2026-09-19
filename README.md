# Xteink Read Later

個人利用向けの記事クリップパイプライン。Android の共有シートから Web 記事 URL を送り、本文を抽出して Xteink で読む EPUB にする。

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
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
```

1 リクエストで fetch → 抽出 → 言語判定 → 翻訳/整形 → EPUB 生成まで走る。成功時は `status: "ready"` と `epubPath`、`timingsMs` を返す。EPUB とメタデータは R2（`wrangler dev` ではローカルシミュレーション）へ保存する。同一 canonical URL の再送は同じ `id` で上書きし、`createdAt` は初回のまま `updatedAt` だけ更新する。

`POST /clip` と `DELETE /articles/:id` は `.dev.vars` の `CLIP_TOKEN` を Bearer で要求する（本番も同じ）。OPDS は CrossPoint JP 向けに HTTP Basic（`OPDS_USERNAME` / `OPDS_PASSWORD`。空パスワード不可）。比較は timing-safe。token はレスポンスにもログにも出さない。

```bash
curl -sS -o clip.json http://localhost:8787/clip \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
curl -sS -o book.epub "http://localhost:8787$(jq -r .epubPath clip.json)"
curl -sS -X DELETE "http://localhost:8787/articles/$(jq -r .id clip.json)" \
  -H "Authorization: Bearer $CLIP_TOKEN"
```

手動削除は `DELETE /articles/:id`。token 不一致は 401、存在しない id は 404。

OPDS 1.2 相当の Atom カタログは `GET /opds`。新しい記事が上で、各 entry の `http://opds-spec.org/acquisition` リンクから EPUB を取る。CrossPoint JP にはこの URL を HTTP Basic 付きで登録する。

```bash
curl -sS -u "$OPDS_USERNAME:$OPDS_PASSWORD" http://localhost:8787/opds
curl -sS -u "$OPDS_USERNAME:$OPDS_PASSWORD" \
  -o book.epub "http://localhost:8787/opds/download/$(jq -r .id clip.json).epub"
```

ログは stage 別の JSON（`fetch` / `extract` / `translate` / `epub` / `store`）で所要時間と失敗 `errorKind` を出す。

英語記事は OpenAI で日本語化し、日本語記事は再翻訳しない。失敗時は `error.code` と `error.message` で原因を返す。翻訳失敗時（503）は `error.extracted` に抽出結果を残す。

`.dev.vars` の `OPENAI_API_KEY` / `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` を使う（リポジトリには入れない）。

| 状態 | 意味 |
| --- | --- |
| 400 | URL 不正 |
| 401 | CLIP_TOKEN または OPDS Basic が無い / 不一致 |
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
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
```

ログは stage / durationMs / errorKind のみ。token や記事全文は出さない。

## Android 共有シート（MAR-40）

ネイティブの Android アプリは作らない。Chrome などから共有シートで [HTTP Shortcuts](https://http-shortcuts.rmy.ch/) に渡し、`POST /clip` する。ショートカット定義はリポジトリにバイナリを置かない。

入れるもの: **HTTP Shortcuts**（[F-Droid](https://f-droid.org/packages/ch.rmy.android.http_shortcuts/) / [Play](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts)）。Xteink 用の専用アプリは不要。

本番 origin を `WORKER` とする（例: `https://xteink-read-later.<account>.workers.dev`、末尾スラッシュなし）。`CLIP_TOKEN` は本文や URL クエリに載せない。Workers が要求するのと同じ `Authorization: Bearer …` を付ける。値は `.dev.vars`（ローカル）または `wrangler secret put CLIP_TOKEN`（本番）と同じもの。この README には値を書かない。

`POST /clip` は JSON `{"url":"…"}` のほか、共有シート向けに `text/plain`（本文が URL または URL を含むテキスト）と `application/x-www-form-urlencoded`（`url` / `text` / `link`）も受ける。タイトル＋URL のような共有文からは最初の `http(s)` URL を使う。

### HTTP Shortcuts の再現手順

1. HTTP Shortcuts を入れる。右下の + から HTTP ショートカットを新規作成。名前は「Xteink Read Later」。
2. グローバル変数:
   - `worker`: Static。値は `WORKER`。
   - `clip_token`: Static。値は `CLIP_TOKEN`。「Treat value as secret」と「Exclude stored value from exports」をオン。
   - `shared_url`: Static。「Allow Receiving Value from Share Dialog」をオン。受け取る部分は **text**。
3. ショートカット本体:
   - 方法: `POST`
   - URL: `{worker}/clip`
   - Authentication: **Bearer**。トークンに `{clip_token}` を入れる（カスタムヘッダで `Authorization: Bearer {clip_token}` でも同じ）。
   - Request Body: Custom Text。`Content-Type: application/json`

```json
{ "url": "{shared_url}" }
```

4. Trigger & Execution Settings で **Direct Share target** をオン（Android 11 以降。共有シートにこのショートカットが出る）。
5. Response Handling:
   - On Success: Dialog か Toast。レスポンス JSON の `title` と `status`（`ready`）が分かること。
   - On Failure（2xx 以外）: Dialog。`error.code` と `error.message` が分かること。
6. 任意の Scripting（JSON を読みやすくする）:

Run on Success:

```js
const body = JSON.parse(response.body)
showToast(body.title + ' · ' + body.status)
```

Run on Failure:

```js
let message = response.body
try {
  const body = JSON.parse(response.body)
  if (body.error) {
    message = body.error.code + ': ' + body.error.message
  }
} catch (e) {}
showDialog(message, 'Xteink Read Later')
```

Chrome で記事を開き、共有 → 「Xteink Read Later」（または HTTP Shortcuts）→ 成功/失敗がダイアログか Toast で分かれば入口は足りる。英語記事なら `translated: true` の日本語 EPUB が R2 に載る。

cURL から取り込む場合の形（token の値は自分の環境の変数に差し替える）:

```bash
curl -sS "$WORKER/clip" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
```

### その後 Xteink で読む

CrossPoint JP に OPDS フィードを登録する。

- カタログ: `WORKER/opds`
- 認証: HTTP Basic（`OPDS_USERNAME` / `OPDS_PASSWORD`。空パスワードは使わない）
- 並び: 新しい記事が上
- 取得: 各 entry の `application/epub+zip` acquisition リンク（`WORKER/opds/download/{id}.epub`）

英語記事を共有したあとは、カタログ先頭の EPUB が日本語になっていることを端末で確認する。
