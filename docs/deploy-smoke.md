# デプロイ後スモーク

`main` で Worker の deploy が成功したあと、同じ workflow の `deploy smoke` が本番 origin を 1 回だけ確認する。朝晩の外形、Access の Cronitor、クリップ失敗の Cronitor とは別で、それらを置き換えない。自動 rollback はしない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。

## 何を見るか

1. `github.sha` と Worker version（Cloudflare の deployments API から取れた version id。取れなければ `unknown`）をログに残す。
2. 専用の日本語記事へ `POST /clip` を **1 回だけ**。202 と jobId を期待する。同じデプロイで再 POST しない。
3. `GET /clip/jobs/:jobId` を `ready` まで待つ。`failed` で止める。上限は 5 分。
4. OPDS の clip 日付棚にその article id があること。
5. EPUB を取り、ZIP の先頭が無圧縮の `mimetype` であること、OPF があること、固定の日本語の一文が本文側にあること。
6. `DELETE /articles/:id` は別ステップで、`if: always()` のため失敗やタイムアウトのあとにも走る。jobId も articleId も取れなくても、POST を試したあとなら記事 URL から計算した id で DELETE する。状態ファイルが無いときも同じ。skip した実行では DELETE しない。

deploy が path filter で skip されたとき、このジョブも skip する。deploy ジョブを再実行して成功すると、`needs: deploy` のためスモークも走る。

成功時は Slack に出さない。失敗したとき、またはジョブがキャンセルされたとき、Slack `#xteink-cronitor` へ 1 通出す。通知ステップの条件は `failure() || cancelled()`。メッセージは `[deploy-smoke]` で始まる。実行と DELETE の両方が失敗したときは、同じ行に `cleanupErrorKind` を足す。

ステップの timeout は checkout 1 分、Node の準備 1 分、install 3 分、スモーク 8 分、DELETE 2 分、通知 1 分で、合計 16 分。ジョブ全体は 18 分。合計がジョブの上限を超えない。

```text
[deploy-smoke] github.sha=0123456789abcdef0123456789abcdef01234567 workerVersion=01234567-89ab-cdef-0123-456789abcdef failedStep=poll-job jobId=job_0123456789abcdef0123456789abcdef lastStage=extract errorKind=fetch_failed runUrl=https://github.com/marufeuille/xteink-read-later/actions/runs/123
```

入れるもの: `github.sha`、Worker version、失敗した工程、jobId、最後の stage、errorKind、Actions の run URL。実行と DELETE の両方が失敗したときだけ `cleanupErrorKind`。入れないもの: 記事 URL、token、パスワード、ハッシュの入力にした生の値、記事本文。ログも同じ。クリップ失敗で Worker の Cronitor `xteink-clip` も鳴ることがある。二重になってよい。

切り分けと、DELETE が残した記事の人手削除は Ops の runbook。

## 専用記事

`pages/smoke/article.html`。タイトルは `[smoke]` で始まる。GitHub Pages の URL は既定で `https://marufeuille.github.io/xteink-read-later/smoke/article.html`。workers.dev と Wikipedia は使わない。

Pages のソースが GitHub Actions になるまで、この URL は届かない。届かないあいだスモークは `未設定: SMOKE_ARTICLE_URL` と記録して成功扱いで skip する。失敗通知は出さない。

有効化は所有者が 1 回だけ行う。このリポジトリは Pages を自分では有効にしない。

1. Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。
2. `.github/workflows/pages.yml` が `pages/smoke/article.html` を `actions/upload-pages-artifact` と `actions/deploy-pages` で出す。`main` でそのパスが変わったときと、`workflow_dispatch` で走る。
3. ソースを変えたあと、失敗している Pages workflow があれば再実行する。

URL を変えるときは、GitHub Actions の Variable `SMOKE_ARTICLE_URL` と、`wrangler.jsonc` の var `SMOKE_ARTICLE_URL` を同じ値にする。Worker のスモーク token は、この URL への `POST /clip` だけを受ける。Variable が空なら既定の Pages URL を使う。

## 秘密

本番の値は置かない。置くのはスモーク専用の値だけ。本番の `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` は GitHub Actions にも、スモーク用の Worker secret にも入れない。

置き場所ごとに 1 つ。GHA には生の値、Worker には SHA-256 の16進だけ。同じ文字列を両方には置かない。値そのものはリポジトリにも PR にも書かない。ワンショットの投入スクリプトは置かない。

### GitHub Actions の secret（生の値）

値が空、または未作成のあいだは `未設定` と記録して skip する。失敗にしない。

| 名前 | 用途 |
| --- | --- |
| `SMOKE_CLIP_TOKEN` | `POST /clip`、job の参照、DELETE に付ける Bearer |
| `SMOKE_OPDS_USERNAME` | OPDS の Basic のユーザー名 |
| `SMOKE_OPDS_PASSWORD` | OPDS の Basic のパスワード |
| `SMOKE_SLACK_WEBHOOK_URL` | `#xteink-cronitor` 向けのスモーク専用 Incoming Webhook |

Webhook は Worker に置かない。ハッシュにもしない。

### Worker の secret（SHA-256 だけ）

Worker が読む名前は次の 2 つだけ。生の値を入れる古い名前 `SMOKE_CLIP_TOKEN` / `SMOKE_OPDS_USERNAME` / `SMOKE_OPDS_PASSWORD` は読まない。残っていれば消す。代替としては残さない。

| 名前 | 中身 |
| --- | --- |
| `SMOKE_CLIP_TOKEN_SHA256` | `SMOKE_CLIP_TOKEN` の UTF-8 バイト列の SHA-256。16進、小文字 |
| `SMOKE_OPDS_BASIC_SHA256` | `ユーザー名:パスワード` の UTF-8 バイト列の SHA-256。16進、小文字。間はコロン 1 つ。Basic が復号する文字列と同じ |

未設定、空、空白だけ、64 桁の16進でない値は「未設定」として扱う。その資格情報では入れない。本番の token へフォールバックしない。空の Bearer や空のユーザー名／パスワードは、空文字のハッシュが置いてあっても一致させない。

照合は、受け取った値を SHA-256 にして、置いてある16進と比べる。大文字の16進は小文字にしてから見る。

既存の Worker secret は Terraform で管理していない。`infra/access` は Cloudflare Access のアプリとポリシーだけ。秘密は所有者が `npx wrangler secret put` で入れる。

ハッシュの作り方。末尾の改行を入れない。`echo` は使わない。出力の16進だけをプロンプトに貼る。コマンドの中の変数は手元のシェルに置き、画面やチャットに生の値を出さない。

```bash
# Linux
printf '%s' "$SMOKE_CLIP_TOKEN" | sha256sum | awk '{print $1}'
printf '%s' "${SMOKE_OPDS_USERNAME}:${SMOKE_OPDS_PASSWORD}" | sha256sum | awk '{print $1}'

# macOS
printf '%s' "$SMOKE_CLIP_TOKEN" | shasum -a 256 | awk '{print $1}'
printf '%s' "${SMOKE_OPDS_USERNAME}:${SMOKE_OPDS_PASSWORD}" | shasum -a 256 | awk '{print $1}'
```

```bash
npx wrangler secret put SMOKE_CLIP_TOKEN_SHA256
npx wrangler secret put SMOKE_OPDS_BASIC_SHA256
```

古い名前が Worker に残っているときだけ消す。

```bash
npx wrangler secret delete SMOKE_CLIP_TOKEN
npx wrangler secret delete SMOKE_OPDS_USERNAME
npx wrangler secret delete SMOKE_OPDS_PASSWORD
```

登録の順は Worker のハッシュを先、GHA の生の値をあと。GHA だけ先に入れると、スモークは 401 で失敗する。どちらも空のあいだは skip する。

スモーク用 Basic の OPDS カタログには、設定された記事 URL の記事だけが出る。本番記事の題名と id は出ない。ダウンロードと DELETE もその記事だけ。候補、購入 EPUB、ダイジェスト、`/clip/recent` には使えない。本番の token の権限は変えない。

GHA の生の値と Worker のハッシュは、同じスモーク専用の資格情報から作る。本番の `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` とは別にする。
