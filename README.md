# Xteink Read Later

個人用の後で読むパイプライン。Web 記事は Android から送り、買った EPUB は手元のファイルを載せる。どちらも同じ OPDS カタログから CrossPoint JP / Xteink で読む。

ネイティブアプリは作らない。マルチユーザーの Read Later サービスにもしない。

## 日常の流れ

本番 origin を `WORKER` とする（例: `https://xteink-read-later.<account>.workers.dev`）。**末尾スラッシュは付けない。** 値（token やパスワード）はこの README に書かない。

### 1. 記事をクリップする（Android）

Chrome などで記事を開き、共有シートから HTTP Shortcuts の「Xteink Read Later」を選ぶ。Worker は URL を受けて **202** `status: "queued"` を返し、本文の取得・翻訳・EPUB は Queue の consumer が別 invocation で行う。HTTP Shortcuts は **202 を成功**として扱う。完成は OPDS の更新、または `npm run clip:status` / `GET /clip/jobs/:jobId`（同じ Bearer）で確認する。

送り先は `POST {worker}/clip`。認証は **Bearer `CLIP_TOKEN`**（JSON 本文や URL クエリには載せない）。パス名は変えない。

### PC のブラウザから記事をクリップする

今開いているタブの URL を、ブックマークレットで確認してからクリップする。`CLIP_TOKEN` はブックマークにも画面にも入れない。認証は Cloudflare Access（Google）。ページを開く GET では受け付けない。「クリップする」の POST で、Android と同じクリップ Queue に載る。

`{worker}/clip/web` を開くと、その origin 向けのブックマークレットが出る。ブックマークの URL に貼る（リンクとしては動かない）。手で書くときは `WORKER` を末尾スラッシュなしの origin にする。

```text
javascript:(function(){location.href='WORKER/clip/web?url='+encodeURIComponent(location.href)})()
```

1. ブックマークの名前は「Xteink にクリップ」。URL は上の文字列。
2. 記事のタブでそのブックマークを開く。Access の確認のあと、表示された URL を見て「クリップする」。
3. 受付は **202** `status: "queued"` と `jobId`。同じ URL が queued / running のあいだは二重に載せない。ready / failed のあと、または 15 分以上更新がないときは新しい実行になる。完成は手順 2 の `clip` 棚、または `npm run clip:status`。

`POST /clip` の Bearer 契約と Android の HTTP Shortcuts はそのまま。Access の対象は `/clip/web` だけで、`/clip` と `/clip/jobs` は入れない。

### 2. Xteink で読む

CrossPoint JP に OPDS カタログを **一度だけ** 登録する。ルートは棚の入口なので、`clip`（Web 記事）か `ebook`（買った本）を開き、その日のフォルダから EPUB を取る。日付の中は新しいものが上。まとめは最新 1 冊だけルートに出る。

登録する URL:

```
https://xteink-read-later.<account>.workers.dev/opds
```

- **https** にする（本番）。`http://` の workers.dev は使わない
- パスは **`/opds`**。origin だけ、`/clip`、`/opds/download/…` はカタログではない
- CrossPoint には **末尾スラッシュなし** で入れる（サーバは `/opds/` も同じルートだが、端末側の取り違えを避ける）
- 認証は **HTTP Basic**（`OPDS_USERNAME` / `OPDS_PASSWORD`）。**`CLIP_TOKEN` や Bearer は使わない**
- 空パスワードは使わない（端末が username-only を送らない）
- 棚を辿って EPUB を取る CrossPoint 実機確認は未実施

英語記事を共有したあとは、その日の `clip` にある EPUB が日本語になっていることを端末で確認する。

### 3. 買った EPUB をカタログに載せる

ネット書店からは取らない。パソコンのブラウザで `{worker}/books` を開く。Cloudflare Access が Google 認証する。`CLIP_TOKEN` の入力欄は無い。EPUB を選び、タイトルは空なら本の `dc:title`、著者は空なら `dc:creator`（無くてもよい）。翻訳・整形・本文の改変はしない。成功画面に「OPDS の ebook 棚に出ます」と出る。同じファイルを再送すると同じ `id` で上書きする。

API は Bearer `CLIP_TOKEN` のまま。`title` は必須で、空タイトルを OPF では埋めない。

```bash
curl -sS "$WORKER/books" \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -F "title=本のタイトル" \
  -F "author=著者名" \
  -F "epub=@book.epub;type=application/epub+zip"
```

上げたあとは手順 2 の `ebook` 棚を更新して読む。秘密値と本文はログにも README にも出さない。`/books` を Access の対象にすると、トークンだけの curl もログイン壁に当たる。その契約をブラウザ外から叩くときは Access の対象から外すか、Service Auth の Bypass を別に足す。

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

`wrangler dev` は既定で `http://localhost:8787` を開く。管理画面は wrangler の Access 開発用 identity（`wrangler.jsonc` の `access.dev`、email `dev@localhost`）で入る。`.dev.vars` の `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` を使う（リポジトリには入れない）。`OPENROUTER_API_KEY` が無いときは記事分類をスキップし、未分類のまま載せる。

`POST /clip` は URL を検証して job を R2 に書き、Queue に `{ jobId, runId, url }` を載せて **202** `status: "queued"` を返す。`jobId` は URL 由来で同じ記事を指し、`runId` は実行ごと。ページ fetch も翻訳も HTTP ではやらない。consumer が抽出 → 翻訳/整形 → EPUB → R2 まで進める。EPUB を書いてから `meta.json` を書く。完了後の記事は `articles/{id}/meta.json` と `book.epub`。job 状態は `jobs/{jobId}.json`（`queued` / `running` / `ready` / `failed`）。本文は job に残さない。同一 URL の再送は同じ `jobId`。queued / running のあいだは二重 enqueue しない。ready / failed のあと、または queued / running が **15 分以上**更新されていないときは新しい `runId` で再投入する。成功時の記事 `id` は現行どおり canonical で決まり、`createdAt` は初回のまま `updatedAt` だけ更新する。古い `runId` の再配信は状態を `running` に戻さない。

`POST /clip`・`GET /clip/jobs/:jobId`・`POST /books`・`DELETE /articles/:id`・`POST /candidates`・`POST /candidates/:id/clip`・`POST /candidates/:id/recommend`・`GET /candidates.json`・`GET /sources.json`・`POST /sources`・`POST /sources/collect`・`POST /digest` は Bearer `CLIP_TOKEN`。候補・情報源・PC クリップ・購入本の **Web 画面**（`/candidates`・`/sources`・`/clip/web`・`/books` とその配下）は Cloudflare Access の Google 認証。Worker は `ctx.access` の email を見る。トークンログインとセッション Cookie は使わない。フォーム POST は CSRF トークン必須。`/clip/web` の GET は URL の確認だけで、クリップの受付は CSRF 付き POST。JSON で送るときは既存の `POST /clip` と同じ **202** `jobId`。`GET /books` は購入 EPUB の投稿画面。Access のフォームはタイトルが空なら OPF の `dc:title`、著者が空なら `dc:creator`。Bearer の `POST /books` は `title` 必須の JSON のまま。`GET /opds`（`clip` / `ebook` と日付を含む）・`GET /articles/:id`・`GET /articles/:id/book.epub`・`GET /opds/download/:id.epub` は HTTP Basic。比較は timing-safe。Access は **Worker 全体には掛けない**（OPDS と `POST /clip` を壊す）。`POST /clip` と `GET /opds`（棚と日付を含む）と `POST /books` と `/clip/web` と候補・情報源の経路は末尾スラッシュありなしを同じルートとして扱う。OPDS は **EPUB がある記事だけ**出す。候補 D1 は R2 の完成記事と別物で、既存記事は移行しない。ジョブ状態の正本は R2 の `jobs/{jobId}.json`。D1 は候補 ID と clip ポインタ、おすすめ判定（本文は持たない）を持つ。

### 読書候補（翻訳しない URL 投入）

見つけた記事 URL を候補として残す。`POST /clip` の即時全文生成契約は変えない。

ブラウザ: `{worker}/candidates` を開く。Cloudflare Access が Google アカウントで入らせる。`CLIP_TOKEN` の入力欄は無い。ローカルの `npm run dev` は wrangler の Access 開発用 identity（`dev@localhost`）を使う。一覧はテーブル形式で、1ページあたり約30件。タイトル（フリーワード）・おすすめ度・ソースで絞り込める。公開日は **Asia/Tokyo (UTC+9)** の暦日。公開日が無い記事は「公開日不明」で、発見日を公開日の代わりにはしない。有料と判定した記事は一覧から外し、投入直後に理由を出す。無料全文を確認できない記事は「本文取得済み」と表示しない。

一覧にはデータエンジニア視点のおすすめ度（おすすめ / 関連あり / 優先度低）と判定状態（未判定・材料不足・低確信・失敗）を出す。理由は固定ラベルのみ。モデル確信度はおすすめ度ではない。判定失敗や低評価でも候補は残し、全文送信は続けられる。手動投入で抽出本文があるときは翻訳前 excerpt で Jev 判定する。フィード収集では時間予算のため未判定のまま残し、一覧の「判定する」で明示評価する。基準は `docs/de-recommend.md`。

一覧の「全文を送る」は既存のクリップ Queue に載せる。状態は未送信 / 準備中 / OPDSで取得可能 / 失敗。失敗は理由と再試行。完成済み EPUB は再利用し、明示の「再生成」だけ新しく作る。「OPDSで取得可能」はカタログ掲載であり、端末のダウンロード済みや読了ではない。選択日時と OPDS の EPUB 取得要求は JSON ログに残す（本文・token・URL は出さない）。読了とはみなさない。

```bash
curl -sS "$WORKER/candidates" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
# 201 { "id":"cand_…", "duplicate": false, "candidate": { "title":"…", "listingState":"listed", … }, "notice": { "kind":"registered", "message":"…" } }
curl -sS "$WORKER/candidates.json" \
  -H "Authorization: Bearer $CLIP_TOKEN"
curl -sS -X POST "$WORKER/candidates/$CANDIDATE_ID/clip" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN"
# 202 { "candidateId":"cand_…", "jobId":"job_…", "runId":"run_…", "status":"queued", "deliveryState":"preparing", "reused": false }
curl -sS -X POST "$WORKER/candidates/$CANDIDATE_ID/recommend" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"force":true}'
# 200 { "candidateId":"cand_…", "reused": false, "candidate": { "recommendation": { "status":"evaluated", "grade":"related", "reasons":["de_relevant"] } } }
```

同一記事はリダイレクト後 URL と canonical でまとめる。別の発見 URL は `candidate_discoveries` に残す（情報源の種別。話題の分類列には混ぜない）。フィード由来は `feed:<sourceId>`、手動投入は `manual_url`。

### 情報源（RSS/Atom の巡回）

企業ブログや Zenn などのフィードを登録し、候補にする。毎日 **04:00 Asia/Tokyo**（UTC 19:00）の Cron が有効な情報源を `FEED_QUEUE`（`xteink-read-later-feed`）に載せる。**06:00 Asia/Tokyo**（UTC 21:00）の集約 Cron が当日号の日本語要約まとめ EPUB を `DIGEST_QUEUE`（`xteink-read-later-digest`）で作り、OPDS のデイリーは最新 1 冊だけ残す。手動の「今すぐ収集」と `POST /digest` も残す。`POST /clip` の全文生成 Queue とは別。媒体ごとの専用パーサは置かない。

ブラウザ: `{worker}/sources`（候補一覧から「情報源」）。名前・サイト URL・フィード URL・情報源種別（企業ブログ / 投稿サイト / ニュース / キュレーション）・任意の話題タグ・有効/停止。種別は記事の話題やおすすめ度とは別。サイト URL だけ入れてフィードを発見できないときは、フィード URL を入れる。RSS の無いサイトは汎用クローラーせず、単発の記事 URL 投入を使う。停止は今後の収集だけ止め、既存候補や送信済み全文は消さない。

初期に通した媒体（専用コードは無い。記録のみ）:

- Zenn トピックフィード（投稿サイト）例: `https://zenn.dev/topics/cloudflare/feed`
- Mercari Engineering Blog（企業ブログ）: `https://engineering.mercari.com/blog/feed.xml`

1 回の収集は情報源ごとに独立する。件数 20、フィードサイズ約 1MB、時間 20 秒、Queue 再試行 3 回が上限。失敗は情報源一覧に出る。同じ「今すぐ収集」か翌日の Cron で再実行する。収集 Cron は enqueue だけで本文翻訳しない。まとめ Cron は無料本文が取れた候補だけを日本語要約し、タイトルやフィード抜粋からは本文を作らない。

```bash
curl -sS "$WORKER/sources" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"name":"Zenn Cloudflare","siteUrl":"https://zenn.dev/topics/cloudflare","feedUrl":"https://zenn.dev/topics/cloudflare/feed","sourceType":"posting_site","topicTags":["cloudflare"]}'
curl -sS "$WORKER/sources/$SOURCE_ID/collect" \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -X POST
```

ローカルの D1 は `wrangler dev` が migrations を適用する。手元で確認するとき:

```bash
npx wrangler d1 migrations apply xteink-read-later-candidates --local
```

本番は main のデプロイジョブがデータベース作成と `wrangler d1 migrations apply --remote` を行う。失敗したらデプロイは進まない。Worker を前のリリースに戻しても D1 のテーブルは残る（未使用になるだけ）。スキーマを戻すときは [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) か、新しい migration で直す。D1 を消さない。R2 の記事・購入 EPUB・OPDS はこの DB と独立している。

### クリップが止まったとき

同じ URL をもう一度 `POST /clip` する。

- `failed`（`queue_failed` / `internal_error` / 取得や翻訳の失敗）ならすぐ再投入される
- Queue 送信に失敗したときは HTTP **503** `queue_failed`。Shortcuts では失敗として出る。同じ URL を再送する
- `queued` / `running` のまま 15 分以上 `updatedAt` が動かない（実行中断や Queue 再試行の打ち切り）ときは、同じ URL の再 POST で新しい実行になる
- 15 分以内の `queued` / `running` は 202 のまま再投入しない
- `GET /clip/jobs/:jobId` で `status` と `error.code` を見る
- 工程ごとの所要時間は下記の `clip:status`（ライブログ）で見る

DLQ は使わない。失敗は job レコードに残る。

### ジョブの進捗・失敗を見る

専用の管理画面や履歴 DB、Workflows は使わない。構造化ログを整形し、最終状態だけ既存の job API で補う。

```bash
# 最終状態（工程内訳はライブ未接続なので不明）
CLIP_TOKEN=… CLIP_BASE_URL="$WORKER" npm run clip:status -- job_…
CLIP_TOKEN=… CLIP_BASE_URL="$WORKER" npm run clip:status -- 'https://example.com/article'

# 1コマンド: job API + 本番ライブログ
CLIP_TOKEN=… CLIP_BASE_URL="$WORKER" npm run clip:status -- --tail job_…

# パイプでも可
npx wrangler tail --format json | CLIP_TOKEN=… CLIP_BASE_URL="$WORKER" npm run clip:status -- --stdin job_…
```

- **認証:** `CLIP_TOKEN` は `GET /clip/jobs/:jobId` の Bearer。CLI 引数・URL クエリ・ログには載せない。`--tail` はそれに加えて `npx wrangler login`（Workers のライブログ）
- **ライブログ:** `wrangler tail` の接続後に出た `event: pipeline` だけ見える。接続前の工程は **不明**（未実行や停止ではない）
- **履歴:** 過去ログの検索・保存はしない。完了済み job に `--tail` しても工程は不明のまま
- **状態:** job は `queued` / `running` / `ready` / `failed`。再試行待ちは `running` かつ直近ログに `errorKind` があるときだけ区別する。ログが無い `running` は **処理中（工程不明）**
- ログに載せるのは stage / durationMs / errorKind / jobId / runId / attempt / articleId と、候補の選択（candidateId / selectedAt / discoveredAt / publishedAt）および OPDS 取得要求（articleId）。token と記事全文と URL は出さない

```bash
curl -sS -o clip.json http://localhost:8787/clip \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
curl -sS -H "Authorization: Bearer $CLIP_TOKEN" \
  "http://localhost:8787/clip/jobs/$(jq -r .jobId clip.json)"
curl -sS -u "$OPDS_USERNAME:$OPDS_PASSWORD" http://localhost:8787/opds
```

ログは stage 別 JSON（`fetch` / `extract` / `translate` / `epub` / `store` / `classify` / `queue`）。各工程に同じ `jobId`（任意で `runId` / `attempt`）を付ける。候補の選択は `event: candidate_clip`、OPDS の EPUB 取得要求は `event: opds_download`（読了ではない）。token と記事全文と URL は出さない。英語記事は OpenAI `gpt-5.6-luna` で日本語化し、日本語記事は再翻訳しない。翻訳失敗は job の `failed`（`error.code` / `error.message` のみ。`extracted` は返さない）。分類は Jev（OpenRouter）で話題と種類を `meta.json` に書くだけ。失敗しても掲載は落とさない。分類の詳細は `docs/classification.md`。モデル選定のメモは `docs/plan/mar-44-translate-models.md`。

| 状態 | 意味 |
| --- | --- |
| 202 | `POST /clip` 受付（`queued`）。Shortcuts では成功 |
| 400 | URL 不正、または購入 EPUB の multipart 不正（`invalid_epub`） |
| 401 | CLIP_TOKEN または OPDS Basic が無い / 不一致 |
| 403 | CSRF トークン不一致 |
| 404 | 記事または job が無い |
| 409 | 情報源が停止、または候補が全文送信不可（有料 / 取得失敗） |
| 413 | 購入 EPUB が上限超過 |
| 422 | （HTTP では出ない。job `extract_failed`） |
| 500 | （HTTP の clip では出ない。job `epub_failed` / `internal_error`） |
| 502 | （HTTP では出ない。job `fetch_failed`） |
| 503 | Queue 送信失敗（`queue_failed`）。job の `translate_failed` も 503 相当だが HTTP の clip では出ない |

`POST /books` は同期のまま 200 `ready`。

## テスト

```bash
npm test
npm run typecheck
```

`npm test` は単体と、fixture + OpenAI モックの E2E。実 `OPENAI_API_KEY` もライブの記事取得も不要。

GitHub Actions が pull request と `main` への push で install / typecheck / 単体 / E2E を回す。**マージしてよい判断基準は CI が緑であること。** `main` ではそのジョブが通ったあとだけ Worker をデプロイする。PR のリスク分類試行（記録のみ）は `docs/pr-risk.md`。

任意のライブ E2E（実ネットワーク。英語記事は OpenAI が必要）はローカル限定:

```bash
E2E_LIVE=1 E2E_LIVE_URL='https://example.com/article' npm run test:e2e:live
```

翻訳モデルの焼比べ（`gpt-4o-mini` / `gpt-4.1-mini` / `gpt-5.6-luna` / `plamo-3.0-prime`。キーが無い候補は skip として出る）:

```bash
npm run translate:bakeoff
```

`.dev.vars` の `OPENAI_API_KEY` / `PLAMO_API_KEY` を読む。シェルで上書きしてもよい。GitHub Secrets にも Worker secret にも置かない。`PLAMO_API_KEY` を `.dev.vars` に足したあと `wrangler types` が `worker-configuration.d.ts` を触ったら、その型差分はコミットしない。

確認は stdout の3軸表（自然さの読み方・速度・コスト）と `tmp/translate-bakeoff/`（gitignore）。自然さは `hedging-prose/<model>.md` を先に読む。表の「未翻訳」は原文の英語コピー。`ok: false` で `is not set` ならキー未到達、`HTTP 401` ならキー無効。

メモは `docs/plan/mar-44-translate-models.md`。

## Cloudflare Workers へデプロイ

`main` への push / merge で GitHub Actions が `wrangler deploy` する。日常のデプロイにローカルの `npm run deploy` は使わない。Workers Paid を前提（`limits.cpu_ms = 30000`）。秘密情報はソースにも Git にも入れない。

CI の `typecheck, unit, e2e` が失敗した run ではデプロイジョブは走らない。**マージしてよいのはそのチェックが緑のときだけ。**

### 初回だけ — Cloudflare 側（Workers Secret）

アプリ用の値は GitHub Secrets に置かず、Worker に一度だけ入れる。以降の Actions デプロイでは上書きされない。R2 バケット `xteink-read-later-articles`、Queue `xteink-read-later-clip`、Queue `xteink-read-later-feed`、D1 `xteink-read-later-candidates` は main のデプロイジョブが無ければ作る（手元で作ってもよい）。

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put CLIP_TOKEN
npx wrangler secret put OPDS_USERNAME
npx wrangler secret put OPDS_PASSWORD
```

プロンプトに値を貼る。この README やリポジトリには書かない。空の `OPDS_PASSWORD` は使わない。任意で `npx wrangler r2 bucket create xteink-read-later-articles`。任意で `npx wrangler queues create xteink-read-later-clip`。任意で `npx wrangler queues create xteink-read-later-feed`。任意で `npx wrangler queues create xteink-read-later-digest`。任意で `npx wrangler d1 create xteink-read-later-candidates`（id はデプロイジョブが wrangler.jsonc に書く）。

### 初回だけ — 管理画面の Google 認証（Cloudflare Access）

候補一覧、情報源、PC クリップ確認、購入本投稿のブラウザ画面を Zero Trust で守る。**Worker 全体を Access にしない。** `/clip`（`POST /clip` と `/clip/jobs`）・`/opds`・`/articles` は Bearer / Basic のまま。`/clip/web` と `/books` を画面として足す。`/books` を足すと同じパスの curl も Access に当たる。Bearer の multipart 契約は Worker に届いたリクエストでは残す。

1. [Zero Trust](https://one.dash.cloudflare.com/) で組織を有効にする。
2. [Google を identity provider にする](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)。Google Cloud の OAuth クライアントが必要。Authorized redirect URI は `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`。
3. **Zero Trust → Access → Applications** で self-hosted アプリを作る。ドメインは本番の `workers.dev` ホストに次のパスだけ（JSON の `/candidates.json` と `/sources.json` は含めない）:
   - `xteink-read-later.<account>.workers.dev/candidates`
   - `xteink-read-later.<account>.workers.dev/candidates/`
   - `xteink-read-later.<account>.workers.dev/candidates/*`
   - `xteink-read-later.<account>.workers.dev/sources`
   - `xteink-read-later.<account>.workers.dev/sources/`
   - `xteink-read-later.<account>.workers.dev/sources/*`
   - `xteink-read-later.<account>.workers.dev/clip/web`
   - `xteink-read-later.<account>.workers.dev/clip/web/`
   - `xteink-read-later.<account>.workers.dev/clip/web/*`
   - `xteink-read-later.<account>.workers.dev/books`
   - `xteink-read-later.<account>.workers.dev/books/`
   - `xteink-read-later.<account>.workers.dev/books/*`
4. Allow ポリシー: Login method = Google、自分の Google メール。Reusable policy をアプリに付ける。`/clip` 自体は入れない（Android の `POST /clip` を Access のログインに通さない）。
5. `/candidates`、`/clip/web`、`/books` を開いて Google で入れること、`/opds` と `POST /clip` が Access ログインに飛ばないことを確認する。

Access を掛ける前にこの変更が本番へ出ると、管理 HTML は 401 になる（JSON API の Bearer は残る）。復旧は Access アプリを足すか、この PR を戻す。

### GitHub Secrets（Actions が Cloudflare に認証するため）

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** に次を足す。値は README に書かない。

| Name | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | [Account API tokens](https://dash.cloudflare.com/profile/api-tokens) で Create Token。テンプレート **Edit Cloudflare Workers** に加え、Account 権限 **Workers R2 Storage: Edit**（バケット作成と bind）、**Workers Queues: Edit**（キュー作成と bind）、**D1: Edit**（データベース作成と migration）。対象アカウントだけに scope する |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボードの [Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |
| `OPENROUTER_API_KEY` | PR リスク分類の試行専用。未設定でも `pr-risk-trial` は記録し、推奨ルートは追加レビュー。設定済みなら Jev の choice / noul / 信頼度もコメントに残る。アプリの記事分類は Cloudflare 側の同じ名前の secret を使う |

アプリ用の `OPENAI_API_KEY` / `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` は GitHub Secrets に入れない（Cloudflare の `wrangler secret put` 側）。`OPENROUTER_API_KEY` は Worker 用と Actions 試行用で別々に置く。

Secrets 未設定のまま `main` にマージすると、チェックは通ってもデプロイジョブが落ちる。

デプロイ後:

```bash
curl -sS https://xteink-read-later.<account>.workers.dev/clip \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $CLIP_TOKEN" \
  -d '{"url":"https://example.com/article"}'
```

ログは stage / durationMs / errorKind / jobId / runId / attempt / articleId。token や記事全文は出さない。手動で送りたいときだけ `npm run deploy` できる。
