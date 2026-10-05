# デプロイ後スモーク

`main` で Worker の deploy が成功したあと、同じ workflow の `deploy smoke` が本番 origin を 1 回だけ確認する。朝晩の外形、Access の Cronitor、クリップ失敗の Cronitor とは別で、それらを置き換えない。スモークがコード起因らしい失敗をしたときは、その deploy の直前に本番で動いていた Worker version へ自動で戻す。

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

ステップの timeout は checkout 1 分、Node の準備 1 分、install 3 分、スモーク 8 分、DELETE 2 分、通知 1 分、結果の export 1 分で、合計 17 分。ジョブ全体は 18 分。合計がジョブの上限を超えない。

```text
[deploy-smoke] github.sha=0123456789abcdef0123456789abcdef01234567 workerVersion=01234567-89ab-cdef-0123-456789abcdef failedStep=poll-job jobId=job_0123456789abcdef0123456789abcdef lastStage=extract errorKind=fetch_failed runUrl=https://github.com/marufeuille/xteink-read-later/actions/runs/123
```

入れるもの: `github.sha`、Worker version、失敗した工程、jobId、最後の stage、errorKind、Actions の run URL。実行と DELETE の両方が失敗したときだけ `cleanupErrorKind`。入れないもの: 記事 URL、token、パスワード、ハッシュの入力にした生の値、記事本文。ログも同じ。クリップ失敗で Worker の Cronitor `xteink-clip` も鳴ることがある。二重になってよい。

切り分け、DELETE が残した記事の人手削除、手動の rollback は Ops の runbook が正本である。その runbook はこのリポジトリには無い。人手の削除手順はそこへ置く。手順はこの文書に複製しない。

## 未設定の skip

GitHub Actions の secret が空または未作成のとき、`SMOKE_ARTICLE_URL` が不正または届かないとき、`SMOKE_ORIGIN` が origin として使えないときは、`未設定: <名前>` とログして skip する。`outcome` は `skipped`。失敗の Slack 通知は出さない。

同じ skip で、GitHub Actions の warning annotation と、そのステップの job summary に、足りない名前だけを並べる。値、token、パスワード、値の一部は出さない。

リポジトリ変数 `SMOKE_REQUIRED` が `true`、`1`、`yes` のとき（大文字小文字は無視し、前後の空白も無視する）、この skip はジョブを失敗にする。未設定、空、それ以外の値では失敗にしない。置く場所は GitHub Actions の Variables で、Secrets ではない。Settings → Secrets and variables → Actions → Variables。workflow は `vars.SMOKE_REQUIRED` を読む。本番でこの変数を有効にするかは、secret が揃ったあとに Ops / PM が決める。

有効にしてジョブが赤になっても、記録した `outcome` は `skipped` のままなので、自動 rollback は skip を戻さない。Slack にも届かない。`skipped` は失敗通知を出さない。見えるのは GitHub の失敗表示と warning annotation、それに job summary だけ。

## 自動 rollback

deploy の直前に、本番の Worker version id を `previous_worker_version` として記録する。同じ応答から、その version を出した git SHA を `previous_worker_sha` として記録する。deploy は `wrangler deploy --message deploy-sha=<github.sha>` で、その SHA を deployment の message に残す。message が version 側にしか無いときは、その version の annotation を読む。`github.event.before` は使わない。失敗した deploy や、concurrency でキャンセルされた run のコミットは本番に出ていないことがあり、その範囲で差分を取ると `migrations/` を見落とす。SHA が message からも annotation からも取れないときは `skipped:unknown_diff` で通知だけし、戻さない。deploy のあと、この run の `worker_version` も記録する。id なしの `wrangler rollback` は使わない。`wrangler secret put` も version を作るので、直前にアップロードされた版は、この deploy の直前とは限らない。version には secret の値も入っている。古すぎる版に戻すと、その日入れたスモーク用ハッシュが落ちることがある。戻すときは、記録した id を指定する。

`deploy rollback` は `deploy` と `deploy smoke` の両方を `needs` に持ち、`if: always()` でスモークが失敗またはキャンセルしたあとにも判定する。対象は、`main` への push で deploy が成功し、スモークが失敗またはキャンセルされたときだけである。成功と、未設定による skip では戻さない。`SMOKE_REQUIRED` でその skip のジョブが失敗になっても、`outcome` が `skipped` なら判定は変わらず戻さない。

戻すのは、次をすべて満たすときだけ。

- スモークの `outcome` が `failed`。skip とキャンセルは対象外
- 失敗が下の表だけ。表に無い失敗は通知するだけで、戻さない

| failedStep | errorKind |
| --- | --- |
| `post-clip` | `http_5xx`（`http_500` から `http_599`） |
| `poll-job` | `extract_failed`、`epub_failed`、`internal_error` |
| `opds-catalog` | `not_in_catalog`、`http_5xx` |
| `download-epub` | `http_5xx` |
| `verify-epub` | `epub_*` |

- `previous_worker_version` と、この run の `worker_version` が両方取れている。`unknown` ではない
- いまの本番 version が、この run の `worker_version` と一致する。古い run や手動の再実行で、より新しいリリースを戻さない
- `previous_worker_sha` からこの run の SHA までの差分に `migrations/` が無く、`wrangler.jsonc` の bindings と triggers も変わっていない

コマンドは、インストール済みの wrangler が受ける形で、version id と `--message` と `--yes` を付ける。

```text
wrangler rollback <previous_worker_version> --message "deploy-rollback sha=… run=…" --yes
```

戻したあと、スモークを 1 回だけ再実行する。結果は `verified` か `still_failing`。再スモークが失敗しても、もう一度は戻さない。再スモークの内部期限は 9 分で、rollback ステップの 12 分より短い。期限までに終わらなければ `verify=-` で通知し、ジョブ summary にも同じ行を書く。`[deploy-rollback]` が `verify=-` のとき、再スモークは期限で打ち切られ、スモーク記事の DELETE が終わらないことがある。残った記事はオペレーターが手で消す。Ops の runbook はこのリポジトリには無く、その人手削除の手順は runbook に置く。手順はこの文書に複製しない。

rollback コマンド自体が失敗したときは、終了コードと、token を含み得ない stderr の先頭だけをジョブのログに出す。その行は Slack にも job summary の本文にも入れない。

D1 のスキーマとデータは戻らない。main の revert も、マージの停止もしない。戻したときは「main には変更が残っています。revert PR が要ります」と通知する。

`[deploy-smoke]` の行はそのまま残す。別に `[deploy-rollback]` を 1 通、同じ `SMOKE_SLACK_WEBHOOK_URL` へ出す。GitHub の job summary にも同じ行を書く。戻す処理自体が失敗したときは、このジョブを失敗にする。

```text
[deploy-rollback] sha=0123456789abcdef0123456789abcdef01234567 from=89abcdef-0123-4567-89ab-cdef01234567 to=01234567-89ab-cdef-0123-456789abcdef trigger=verify-epub/epub_phrase result=rolled_back verify=verified runUrl=https://github.com/marufeuille/xteink-read-later/actions/runs/123 main には変更が残っています。revert PR が要ります
```

入れるもの: `sha`、`from`、`to`、`trigger`（failedStep / errorKind）、`result`（`rolled_back` / `rollback_failed` / `skipped:<理由>`）、`verify`（`verified` / `still_failing` / `-`）、Actions の run URL。戻したときだけ、main に変更が残っていること。入れないもの: 記事 URL、token、パスワード、ハッシュの入力にした生の値、記事本文。

`result` が `skipped:` になる例: `migration`（`migrations/`、または bindings / triggers）、`unknown_diff`（本番 version の SHA が取れない）、`version_mismatch`（本番がこの run の version ではない。古い run や手動の再実行を含む）、`external`（`network` / `fetch_failed` / `http_401` / `http_403` / `interrupted`）、`unknown_version`。`poll-job` の `timeout`、`article-preflight`、DELETE だけの失敗、表に無い失敗も戻さない。

トークンは既存の GitHub Actions secret `CLOUDFLARE_API_TOKEN` を使う。新しい secret は作らない。

手動で戻すときの手順は、上の Ops の runbook に従う。この文書にはその手順を複製しない。

## 専用記事

`pages/smoke/article.html`。タイトルは `[smoke]` で始まる。GitHub Pages の URL は既定で `https://marufeuille.github.io/xteink-read-later/smoke/article.html`。workers.dev と Wikipedia は使わない。

Pages のソースが GitHub Actions になるまで、この URL は届かない。届かないあいだスモークは `未設定: SMOKE_ARTICLE_URL` と記録して skip する。見え方と `SMOKE_REQUIRED` は「未設定の skip」。失敗通知は出さない。

有効化は所有者が 1 回だけ行う。このリポジトリは Pages を自分では有効にしない。

1. Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。
2. `.github/workflows/pages.yml` が `pages/smoke/article.html` を `actions/upload-pages-artifact` と `actions/deploy-pages` で出す。`main` でそのパスが変わったときと、`workflow_dispatch` で走る。
3. ソースを変えたあと、失敗している Pages workflow があれば再実行する。

URL を変えるときは、GitHub Actions の Variable `SMOKE_ARTICLE_URL` と、`wrangler.jsonc` の var `SMOKE_ARTICLE_URL` を同じ値にする。Worker のスモーク token は、この URL への `POST /clip` だけを受ける。Variable が空なら既定の Pages URL を使う。

## 秘密

本番の値は置かない。置くのはスモーク専用の値だけ。本番の `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` は GitHub Actions にも、スモーク用の Worker secret にも入れない。

置き場所ごとに 1 つ。GHA には生の値、Worker には SHA-256 の16進だけ。同じ文字列を両方には置かない。値そのものはリポジトリにも PR にも書かない。ワンショットの投入スクリプトは置かない。

### GitHub Actions の secret（生の値）

値が空、または未作成のあいだは `未設定` と記録して skip する。見え方と `SMOKE_REQUIRED` は「未設定の skip」。

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

`SMOKE_CLIP_TOKEN_SHA256` の作り方。末尾の改行を入れない。`echo` で値をパイプしない。値をコマンドラインに書かない。`VAR=値` も `export VAR=値` も履歴に残る。`read -rs -p '...' VAR` は使わない。zsh では `-p` が別の意味になり、変数が空になる。プロンプトは `printf`、秘密の読み取りは `read -rs`。登録前に `echo ${#VAR}` で桁数だけ見る。値は出さない。`set -x` は付けない。`read` より後ろの行を、同じ貼り付けに入れない。

OPDS のユーザー名、パスワード、`SMOKE_OPDS_BASIC_SHA256` の追加・削除・ローテーションは [opds-accounts.md](opds-accounts.md)。本番の資格情報をスモークに使わない。本番パスワードを替えるときに、スモークのハッシュが古い本番パスワードのままなら、先に、または同じ作業で、スモーク専用の値へ替える。

クリップ token を手で決めるとき。この 2 行だけ実行し、プロンプトのあとで値を打つ。

```bash
printf 'SMOKE_CLIP_TOKEN: '
read -rs SMOKE_CLIP_TOKEN
```

`read -rs` は Enter の改行を画面に出さない。桁数は別に見る。0 なら入れない。

```bash
printf '\n'
echo ${#SMOKE_CLIP_TOKEN}
```

ランダムで作るとき。`openssl rand -hex 32` の桁数は 64。

```bash
SMOKE_CLIP_TOKEN=$(openssl rand -hex 32)
echo ${#SMOKE_CLIP_TOKEN}
```

ハッシュは `sha256sum` があればそれを、無ければ `shasum -a 256` を使う。macOS には `sha256sum` が無い。bash と zsh の両方で動く。token が 0 のときは `0` と出て、ハッシュは作らない。空の入力でも SHA-256 自体は 64 桁になる。`gh secret set --body` に値を書かない。

```bash
if [ "${#SMOKE_CLIP_TOKEN}" -eq 0 ]; then
  echo 0
elif command -v sha256sum >/dev/null 2>&1; then
  SMOKE_CLIP_TOKEN_SHA256=$(printf '%s' "$SMOKE_CLIP_TOKEN" | sha256sum | awk '{print $1}')
  echo ${#SMOKE_CLIP_TOKEN_SHA256}
else
  SMOKE_CLIP_TOKEN_SHA256=$(printf '%s' "$SMOKE_CLIP_TOKEN" | shasum -a 256 | awk '{print $1}')
  echo ${#SMOKE_CLIP_TOKEN_SHA256}
fi
```

64 のときだけ登録する。Worker のハッシュを先、GitHub Actions の生の値をあと。失敗したときは `unset` の前に止めて、同じ変数でやり直す。

```bash
printf '%s' "$SMOKE_CLIP_TOKEN_SHA256" | npx wrangler secret put SMOKE_CLIP_TOKEN_SHA256
printf '%s' "$SMOKE_CLIP_TOKEN" | gh secret set SMOKE_CLIP_TOKEN
```

登録できたら unset する。

```bash
unset SMOKE_CLIP_TOKEN SMOKE_CLIP_TOKEN_SHA256
```

古い名前が Worker に残っているときだけ消す。

```bash
npx wrangler secret delete SMOKE_CLIP_TOKEN
npx wrangler secret delete SMOKE_OPDS_USERNAME
npx wrangler secret delete SMOKE_OPDS_PASSWORD
```

登録の順は Worker のハッシュを先、GHA の生の値をあと。GHA だけ先に入れると、スモークは 401 で失敗する。どちらも空のあいだは skip する。

スモーク用 Basic の OPDS カタログには、設定された記事 URL の記事だけが出る。本番記事の題名と id は出ない。ダウンロードと DELETE もその記事だけ。候補、購入 EPUB、ダイジェスト、`/clip/recent` には使えない。本番の token の権限は変えない。

GHA の生の値と Worker のハッシュは、同じスモーク専用の資格情報から作る。本番の `CLIP_TOKEN` / `OPDS_USERNAME` / `OPDS_PASSWORD` とは別にする。OPDS のコマンドは [opds-accounts.md](opds-accounts.md)。
