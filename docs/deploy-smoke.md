# デプロイ後スモーク

`main` で Worker の deploy が成功したあと、同じ workflow の `deploy smoke` が本番 origin を 1 回だけ確認する。朝晩の外形、Access の Cronitor、クリップ失敗の Cronitor とは別で、それらを置き換えない。自動 rollback はしない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。

## 何を見るか

1. `github.sha` と Worker version（Cloudflare の deployments API から取れた version id。取れなければ `unknown`）をログに残す。
2. 専用の日本語記事へ `POST /clip` を **1 回だけ**。202 と jobId を期待する。同じデプロイで再 POST しない。
3. `GET /clip/jobs/:jobId` を `ready` まで待つ。`failed` で止める。上限は 5 分。
4. OPDS の clip 日付棚にその article id があること。
5. EPUB を取り、ZIP の先頭が無圧縮の `mimetype` であること、OPF があること、固定の日本語の一文が本文側にあること。
6. `DELETE /articles/:id` は別ステップで、`if: always()` のため失敗やタイムアウトのあとにも走る。

deploy が path filter で skip されたとき、このジョブも skip する。deploy ジョブを再実行して成功すると、`needs: deploy` のためスモークも走る。

成功時は Slack に出さない。失敗時はジョブを赤くし、Slack `#xteink-cronitor` へ 1 通出す。メッセージは `[deploy-smoke]` で始まる。

```text
[deploy-smoke] github.sha=0123456789abcdef0123456789abcdef01234567 workerVersion=01234567-89ab-cdef-0123-456789abcdef failedStep=poll-job jobId=job_0123456789abcdef0123456789abcdef lastStage=extract errorKind=fetch_failed runUrl=https://github.com/marufeuille/xteink-read-later/actions/runs/123
```

入れるもの: `github.sha`、Worker version、失敗した工程、jobId、最後の stage、errorKind、Actions の run URL。入れないもの: 記事 URL、token、記事本文。ログも同じ。クリップ失敗で Worker の Cronitor `xteink-clip` も鳴ることがある。二重になってよい。

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

本番の `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` は GitHub Actions に置かない。スモークは別の値。

GitHub Actions の secret（値が空、または未作成のあいだは `未設定` と記録して skip。失敗にしない）:

| 名前 | 用途 |
| --- | --- |
| `SMOKE_CLIP_TOKEN` | `POST /clip`、job の参照、DELETE |
| `SMOKE_OPDS_USERNAME` | OPDS の Basic |
| `SMOKE_OPDS_PASSWORD` | OPDS の Basic |
| `SMOKE_SLACK_WEBHOOK_URL` | `#xteink-cronitor` 向けのスモーク専用 Incoming Webhook |

Worker 側は同じ 3 つの資格情報を、本番とは別に受ける。Webhook は Worker に置かない。

既存の Worker secret は Terraform で管理していない。`infra/access` は Cloudflare Access のアプリとポリシーだけ。秘密はこれまでどおり所有者が `npx wrangler secret put` で入れる。スモークも同じ。値はリポジトリに書かない。ワンショットの投入スクリプトは置かない。

```bash
npx wrangler secret put SMOKE_CLIP_TOKEN
npx wrangler secret put SMOKE_OPDS_USERNAME
npx wrangler secret put SMOKE_OPDS_PASSWORD
```

Worker 側が未設定、空、空白だけのときは、その資格情報では入れない。本番の token へフォールバックしない。空文字同士も一致させない。

スモーク token でできることは、設定された記事 URL の clip、その job の参照、OPDS カタログの参照、その記事のダウンロード、その記事の DELETE。候補、購入 EPUB、ダイジェスト、`/clip/recent` には使えない。本番の token の権限は変えない。

GHA と Worker に入れるスモークの値は、互いに同じ組で、本番の値とは別にする。
