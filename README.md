# Xteink Read Later

個人用の後で読むパイプライン。Web 記事は Android から送り、買った EPUB は手元のファイルを載せる。どちらも同じ OPDS カタログから CrossPoint JP / Xteink で読む。

ネイティブアプリは作らない。マルチユーザーの Read Later サービスにもしない。

## 日常の流れ

本番 origin を `WORKER` とする（例: `https://xteink-read-later.<account>.workers.dev`）。**末尾スラッシュは付けない。** 値（token やパスワード）はこの README に書かない。

### 1. 記事をクリップする（Android）

Chrome などで記事を開き、共有シートから HTTP Shortcuts の「Xteink Read Later」を選ぶ。Worker は URL を受けて **202** `status: "queued"` を返し、本文の取得・翻訳・EPUB は Queue の consumer が別 invocation で行う。HTTP Shortcuts は **202 を成功**として扱う。完成は OPDS の更新、または任意で `GET /clip/jobs/:jobId`（同じ Bearer）で確認する。

送り先は `POST {worker}/clip`。認証は **Bearer `CLIP_TOKEN`**（JSON 本文や URL クエリには載せない）。パス名は変えない。

### 2. Xteink で読む

CrossPoint JP に OPDS カタログを **一度だけ** 登録する。そのあと端末の一覧を開き、新しいものが上にあることを確認して EPUB を取る。

登録する URL:

```
https://xteink-read-later.<account>.workers.dev/opds
```

- **https** にする（本番）。`http://` の workers.dev は使わない
- パスは **`/opds`**。origin だけ、`/clip`、`/opds/download/…` はカタログではない
- CrossPoint には **末尾スラッシュなし** で入れる（サーバは `/opds/` も同じルートだが、端末側の取り違えを避ける）
- 認証は **HTTP Basic**（`OPDS_USERNAME` / `OPDS_PASSWORD`）。**`CLIP_TOKEN` や Bearer は使わない**
- 空パスワードは使わない（端末が username-only を送らない）

英語記事を共有したあとは、カタログ先頭の EPUB が日本語になっていることを端末で確認する。

### 3. 買った EPUB をカタログに載せる

ネット書店からは取らない。パソコンに置いてある EPUB を `CLIP_TOKEN` 付きで上げる。翻訳も抽出もサニタイズもしない。同じファイルを再送すると同じ `id` で上書きする。

```bash
curl -sS "$WORKER/books" \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -F "title=本のタイトル" \
  -F "author=著者名" \
  -F "epub=@book.epub;type=application/epub+zip"
```

上げたあとは手順 2 と同じカタログを更新して読む。秘密値と本文はログにも README にも出さない。

削除は `DELETE /articles/:id`（Bearer `CLIP_TOKEN`）。無い id は 404。

## HTTP Shortcuts

入れるもの: [HTTP Shortcuts](https://http-shortcuts.rmy.ch/)（[F-Droid](https://f-droid.org/packages/ch.rmy.android.http_shortcuts/) / [Play](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts)）。ショートカット定義はリポジトリに置かない。

`CLIP_TOKEN` は `.dev.vars`（ローカル）または `wrangler secret put CLIP_TOKEN`（本番）と同じもの。

`POST /clip` は JSON `{"url":"…"}` のほか、`text/plain` と `application/x-www-form-urlencoded`（`url` / `text` / `link`）も受ける。タイトル＋URL の共有文からは最初の `http(s)` URL を使う。

### 再現手順

1. HTTP Shortcuts を入れる。右下の + から HTTP ショートカットを新規作成。名前は「Xteink Read Later」。
2. グローバル変数:
   - `worker`: Static。値は `WORKER`（末尾スラッシュなし）。
   - `clip_token`: Static。値は `CLIP_TOKEN`。「Treat value as secret」と「Exclude stored value from exports」をオン。
   - `shared_url`: Static。「Allow Receiving Value from Share Dialog」をオン。受け取る部分は **text**。
3. ショートカット本体:
   - 方法: `POST`
   - URL: `{worker}/clip`
   - Authentication: **Bearer**。トークンに `{clip_token}` を入れる。
   - Request Body: Custom Text。`Content-Type: application/json`

```json
{ "url": "{shared_url}" }
```

4. Trigger & Execution Settings で **Direct Share target** をオン（Android 11 以降）。
5. Response Handling:
   - **2xx（202 を含む）は成功。** On Success: Dialog か Toast。`status`（`queued`）と `jobId` が分かること。`title` や `ready` は 202 には出ない。
   - On Failure（2xx 以外）: Dialog。`error.code` と `error.message` が分かること。
6. Scripting は任意。**関数の外に `return` を書かない**（HTTP Shortcuts が「return not in a function」で Worker の JSON を隠す）。`JSON.parse` は try/catch する。

Run on Success:

```js
let status = ''
let jobId = ''
try {
  const body = JSON.parse(response.body)
  status = body.status || ''
  jobId = body.jobId || ''
} catch (e) {}
showToast(status + ' · ' + jobId)
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

手元から確認するとき:

```bash
curl -sS "$WORKER/clip" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
# 202 { "jobId":"job_…", "status":"queued", "sourceUrl":"…" }
curl -sS "$WORKER/clip/jobs/$JOB_ID" \
  -H "Authorization: Bearer $CLIP_TOKEN"
```

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`wrangler dev` は既定で `http://localhost:8787` を開く。`.dev.vars` の `OPENAI_API_KEY` / `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` を使う（リポジトリには入れない）。

`POST /clip` は URL を検証して job を R2 に書き、Queue に `{ jobId, url }` だけ載せて **202** `status: "queued"` を返す。ページ fetch も翻訳も HTTP ではやらない。consumer が抽出 → 翻訳/整形 → EPUB → R2 まで進める。完了後の記事は `articles/{id}/meta.json` と `book.epub`。job 状態は `jobs/{jobId}.json`（`queued` / `running` / `ready` / `failed`）。本文は job に残さない。同一 URL の再送は同じ `jobId`。queued / running のあいだは二重 enqueue しない。ready / failed のあとなら新しい実行を載せる。成功時の記事 `id` は現行どおり canonical で決まり、`createdAt` は初回のまま `updatedAt` だけ更新する。

`POST /clip`・`GET /clip/jobs/:jobId`・`POST /books`・`DELETE /articles/:id` は Bearer `CLIP_TOKEN`。`GET /opds`・`GET /articles/:id`・`GET /articles/:id/book.epub`・`GET /opds/download/:id.epub` は HTTP Basic。比較は timing-safe。`POST /clip` と `GET /opds` と `POST /books` は末尾スラッシュありなしを同じルートとして扱う。OPDS は **ready の記事だけ**出す。

```bash
curl -sS -o clip.json http://localhost:8787/clip \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
curl -sS -H "Authorization: Bearer $CLIP_TOKEN" \
  "http://localhost:8787/clip/jobs/$(jq -r .jobId clip.json)"
curl -sS -u "$OPDS_USERNAME:$OPDS_PASSWORD" http://localhost:8787/opds
```

ログは stage 別 JSON（`fetch` / `extract` / `translate` / `epub` / `store` / `queue`）。token と記事全文は出さない。英語記事は OpenAI で日本語化し、日本語記事は再翻訳しない。翻訳失敗は job の `failed`（`error.code` / `error.message` のみ。`extracted` は返さない）。

| 状態 | 意味 |
| --- | --- |
| 202 | `POST /clip` 受付（`queued`）。Shortcuts では成功 |
| 400 | URL 不正、または購入 EPUB の multipart 不正（`invalid_epub`） |
| 401 | CLIP_TOKEN または OPDS Basic が無い / 不一致 |
| 404 | 記事または job が無い |
| 413 | 購入 EPUB が上限超過 |
| 422 | （HTTP では出ない。job `extract_failed`） |
| 500 | （HTTP の clip では出ない。job `epub_failed`） |
| 502 | （HTTP では出ない。job `fetch_failed`） |
| 503 | （HTTP では出ない。job `translate_failed`） |

`POST /books` は同期のまま 200 `ready`。

## テスト

```bash
npm test
npm run typecheck
```

`npm test` は単体と、fixture + OpenAI モックの E2E。実 `OPENAI_API_KEY` もライブの記事取得も不要。

GitHub Actions が pull request と `main` への push で install / typecheck / 単体 / E2E を回す。**マージしてよい判断基準は CI が緑であること。** `main` ではそのジョブが通ったあとだけ Worker をデプロイする。

任意のライブ E2E（実ネットワーク。英語記事は OpenAI が必要）はローカル限定:

```bash
E2E_LIVE=1 E2E_LIVE_URL='https://example.com/article' npm run test:e2e:live
```

## Cloudflare Workers へデプロイ

`main` への push / merge で GitHub Actions が `wrangler deploy` する。日常のデプロイにローカルの `npm run deploy` は使わない。Workers Paid を前提（`limits.cpu_ms = 30000`）。秘密情報はソースにも Git にも入れない。

CI の `typecheck, unit, e2e` が失敗した run ではデプロイジョブは走らない。**マージしてよいのはそのチェックが緑のときだけ。**

### 初回だけ — Cloudflare 側（Workers Secret）

アプリ用の値は GitHub Secrets に置かず、Worker に一度だけ入れる。以降の Actions デプロイでは上書きされない。R2 バケット `xteink-read-later-articles` と Queue `xteink-read-later-clip` は main のデプロイジョブが無ければ作る（手元で作ってもよい）。

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CLIP_TOKEN
npx wrangler secret put OPDS_USERNAME
npx wrangler secret put OPDS_PASSWORD
```

プロンプトに値を貼る。この README やリポジトリには書かない。空の `OPDS_PASSWORD` は使わない。任意で `npx wrangler r2 bucket create xteink-read-later-articles`。任意で `npx wrangler queues create xteink-read-later-clip`。

### GitHub Secrets（Actions が Cloudflare に認証するため）

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** に次の 2 つだけ足す。値は README に書かない。

| Name | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | [Account API tokens](https://dash.cloudflare.com/profile/api-tokens) で Create Token。テンプレート **Edit Cloudflare Workers** に加え、Account 権限 **Workers R2 Storage: Edit**（バケット作成と bind）と **Workers Queues: Edit**（キュー作成と bind）。対象アカウントだけに scope する |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボードの [Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |

次は **GitHub Secrets に入れない**（Cloudflare の `wrangler secret put` 側）: `OPENAI_API_KEY` / `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD`。

Secrets 未設定のまま `main` にマージすると、チェックは通ってもデプロイジョブが落ちる。

デプロイ後:

```bash
curl -sS https://xteink-read-later.<account>.workers.dev/clip \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
```

ログは stage / durationMs / errorKind / jobId のみ。token や記事全文は出さない。手動で送りたいときだけ `npm run deploy` できる。
