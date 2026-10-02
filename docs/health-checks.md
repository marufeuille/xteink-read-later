# 本番スモークの合否

ステータスだけで切るのは朝晩と、Access の外形監視と、Access の経路を変えたあと。Cronitor の Job 監視（定期収集とクリップ）は同じ文書の後半で、ステータススモークではない。カタログの中身、秘密の値、ダッシュボードのクリック手順は書かない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。末尾スラッシュは付けない。リダイレクトは追わない。最初のステータスを見る。

パスの正本は [access-as-code.md](access-as-code.md)。ログの日次は [workers-logs.md](workers-logs.md)。OPDS の識別子は [daily-opds.md](daily-opds.md)。

## いつやるか

| 枠 | 何を見るか | 誰が・いつ |
| --- | --- | --- |
| 朝晩 | `/opds` 401 と `/candidates.json` Bearer 200 | Ops ルーチン folder `xteink`（8:39 / 20:39 JST）。Access パスは見ない |
| Access 外形監視（別監視） | `/books` 壁あり・`/digest/send` 壁なし | **Cronitor Hacker（$0 / 約 5 monitors）** が外から定期プローブ。落ちたらメール等で Ops が Linear を切る。朝晩とは別 |
| Job 監視（別監視） | 定期収集の cron とクリップ queue の成否 | Worker が Cronitor Telemetry（`state=run` / `complete` / `fail`）を送る。Access 外形監視とは別。Heartbeat 単体はまだ置かない |
| Access の経路を変えたとき | 上に加え、Basic `/opds` 200 と `/clip/recent` 壁 | 人手。Access の対象パスや Zero Trust の覆いを変えたデプロイのあとだけ |

Access 外形監視は MAR-150（Access Terraform CI）とも、朝晩ヘルスとも独立。既存の `/opds` Basic 401 とはパスが違うので衝突しない。

## 朝晩

| パス | 認証 | 期待ステータス | いつ |
| --- | --- | --- | --- |
| `GET /opds` | なし | **401** | 朝晩。Access を変えていないデプロイのあと |
| `GET /candidates.json` | `Authorization: Bearer`。値は Worker secret の `CLIP_TOKEN` | **200** で、ボディが JSON | 同上 |

`GET /opds` の 401 は Worker が生きている印。Worker は `WWW-Authenticate: Basic realm="Xteink Read Later"` を付ける。タイムアウト、5xx、`*.cloudflareaccess.com` へのリダイレクト、401 以外は異常。

`GET /candidates.json` はパスが `.json` なので、Bearer があれば JSON を返す。件数や候補の中身は見ない。`CLIP_TOKEN` の値はここに書かない。このパスは Access の対象外。HTML の `/candidates` とは別。

## Access 外形監視（別監視・定期）

**目的:** Access 方針がずれたら、Ops / box が止まっていても外から検知できること。

**採用スタック:** [Cronitor](https://cronitor.io/) **Hacker（$0 / 約 5 monitors）**。モニターは Cronitor の UI で置く（as-code ではない）。外から HTTP を叩き、期待と違うときメールで知らせる。朝晩ヘルス（Ops ルーチン folder `xteink`）とは別。Checkly は無料でも status / header 断言はあるが、**Service API key が Enterprise 専用**で Hobby / Trial から CI / as-code deploy できないため見送り。Cloudflare Health Checks は Free では不可（Pro+）。UptimeRobot Free はカスタム 404=UP が有料で `/digest/send` に向かない。

### 期待（正本）

| パス | 認証 | 期待 | 不合格の例 |
| --- | --- | --- | --- |
| `GET /books` | Access のセッションなし | **302**。`Location` に `cloudflareaccess.com` を含む。リダイレクトは追わない | Worker の **401** / **200** / 5xx、Access 以外への 302、タイムアウト |
| `GET /digest/send` | なし | Access に飛ばない。Worker の **404** | `*.cloudflareaccess.com` へのリダイレクト、5xx、タイムアウト |

いまのチームのログインホストは `marufeuille.cloudflareaccess.com`。`GET /digest/send` のパス単体に Worker ルートは無く、届いたときのステータスは **404**。署名付きの `/digest/send/:candidateId/:expires/:token` は監視しない。

### Cronitor モニター設定（Masahiro が UI で作成）

アカウント: [Cronitor Hacker](https://cronitor.io/pricing)（$0。クレカ不要の表記）。モニターは 2 本。定義はリポジトリに置かない。

共通: Method GET、Follow redirects **OFF**、間隔 every 5 minutes。認証ヘッダは付けない。

1. **`xteink-books-access-wall`**
   - Type: Website / HTTP check
   - URL: `https://xteink-read-later.marufeuille.workers.dev/books`
   - Assertions:
     - `response.code = 302`
     - `response.header Location contains cloudflareaccess.com`
2. **`xteink-digest-send-no-access`**
   - URL: `https://xteink-read-later.marufeuille.workers.dev/digest/send`
   - Assertions:
     - `response.code = 404`

Alerts: Email を Masahiro へ。任意で第二の宛先（Ops inbox）にも送り、メール起動で Linear を切る。秘密値は Cronitor に置かない。

### 異常のとき（Ops）

既存 Ops 通知に揃える。Marufeuille / Xteink Read Later に Linear を切る（どのモニターか・観測ステータス・`Location` ホスト・次の手）。token / パスワードは書かない。

直し方の目安:

1. [access-as-code.md](access-as-code.md) の Allow / Bypass と本番 Zero Trust が一致しているか見る。
2. `/books` が壁なし → Allow の destinations に `/books`（と `/books/` / `/books/*`）があるか。消えていれば Access 側を戻す。
3. `/digest/send` が壁あり → Bypass アプリ（ホスト + `/digest/send`）が生きているか。親の `/digest` Allow が配下を飲み込んでいないか。
4. 直したあと Cronitor が緑に戻ることと、朝晩の `/opds` 401 が壊れていないことを確認する。

### なぜ Cronitor か（短い比較）

| 候補 | 判定 |
| --- | --- |
| **Cronitor Hacker（採用）** | $0 / 約 5 monitors。`response.code` / header 断言可。302+Location と 404 をそのまま「正常」にできる。UI で置き、朝晩（folder `xteink`）とは別。メール |
| Checkly Hobby | 無料で status / header 断言はある。**Service API key は Enterprise 専用**なので、Hobby / Trial では as-code / CI deploy に使える永続キーが無く、見送り |
| UptimeRobot Free | 既定は 2xx/3xx=UP なので `/books` 302 は可だが、**404 を UP にするカスタムステータスは有料** → `/digest/send` 不向き |
| Cloudflare Health Checks | **Free では不可**（Pro+） |
| Ops curl のみ | 実装は簡単だが、Ops/box 障害時に見逃す。補助にはできるが主検知にはしない |

## Cronitor Job 監視（定期収集とクリップ）

Access 外形監視の Website check（`xteink-books-access-wall` / `xteink-digest-send-no-access`）とは別。それらは残す。置き換えない。Heartbeat だけのモニターはまだ置かない。

Worker が [Telemetry API](https://cronitor.io/docs/telemetry-api) へ Job の寿命を送る。URL は `https://cronitor.link/p/<API key>/<monitor key>`。`state=run` が開始、`complete` が成功終了、`fail` が失敗。メトリックは `metric` を繰り返す。`count`、`duration`（秒）、`error_count`。同じ実行の `run` と `complete` / `fail` は `series` で揃える。

ping の失敗、タイムアウト、非 2xx、secret の未設定や空文字は本処理を失敗させない。各 ping は最大 2 秒で打ち切る（DNS、接続、許可したリダイレクトを同じ制限に含める）。応答ステータスを読み、本文は上限まで読む。`https://cronitor.link` と `https://eu.cronitor.link` への https リダイレクトだけ、最大 2 回まで辿る。それ以外の `Location` は辿らない。API key はパスに入るので、他ホストへは渡さない。API key、モニターキー、記事 URL、例外メッセージは Cronitor の `message` に載せない。失敗時の `message` は固定文（`feed collection failed` / `clip processing failed`）だけ。

本番の Workers `fetch()` は `cronitor.link` に届かず、`outcome=network` になる。同じ URL を公開インターネットの IPv4（`44.230.87.160` / `54.68.179.145`）へ HTTP/1.1 で出すと `200` と `Content-Length: 0` が返る。`cronitor.link` は A と AAAA の両方を持ち、Workers の `fetch()` は A レコードを指定できず、Cloudflare の anycast から出る。記事取得の `fetch()` は同じ Worker で成功するので、Worker 全体の外向きが止まっているわけではない。

そのため本番の ping は Workers の `fetch()` を使わない。DNS-over-HTTPS（`https://cloudflare-dns.com/dns-query`、type A）で引いた公開 IPv4 に、Workers の TCP ソケットで TLS する。ソケットの出口は [Cloudflare の公開 IP レンジの外](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)にある。`Host` は許可ホストだけ。`Connection: close` の HTTP/1.1 GET を書き、書き側は応答ステータスを読むまで閉じない。先に閉じると TLS の close_notify で応答バイトが落ち、Cronitor は ping を記録したまま Worker は `cause=http` になる。`Content-Length: 0` の 200 も `Transfer-Encoding: chunked` の 2xx も `sent` にする。ステータス行の前で切れた接続は `cause=connect`、ヘッダが HTTP として壊れているときは `cause=http`。プライベートアドレス、文書用アドレス、許可ホスト以外には繋がない。IP リテラルには `startTls({ expectedServerHostname })` を渡す。本番の edge はこの名前を SNI に使わないことがあり、ソケットは開いたあと読み取りで失敗する。その失敗と、接続そのものの拒否は、次の公開 IPv4 を試し、最後に同じソケット API でホスト名へ繋ぐ。ホスト名への `startTls()` は引数を渡さず、接続先の名前を SNI にする。`cloudflare:sockets` を読めないときは `fetch` に戻さない。`transport` は `ipv4`、`cause` は `sockets` にして、本処理は続ける。

送ったかどうかは Workers Logs の `event=cronitor` で見る。`outcome` は `sent`（HTTP 2xx）、`http_error`、`timeout`、`network`、`redirect_blocked`、`invalid_ping`、`metrics_failed`、または secret が使えないときの `missing_api_key` / `blank_api_key` / `api_key_not_string` / `missing_monitor_key` / `blank_monitor_key` / `monitor_key_not_string`。`pingState` は `run` / `complete` / `fail`。`httpStatus` は数値だけ。ソケット経路のとき `transport` は `ipv4`。失敗時の `cause` は `dns` / `connect` / `http` / `sockets` だけ。`sockets` はソケットを読めず、`fetch` には戻していない。ログに API key、モニターキー、URL、IP、記事 URL、レスポンス本文、例外メッセージは出さない。Cronitor は資格情報が違っても HTTP 200 を返すことがある。`sent` は HTTP 2xx のステータスを読んだ印であり、本文が空でも chunked でも同じである。ダッシュボードに載った証明ではない。Ops はダッシュボードとこのログの両方を見る。

| Worker secret | 何を見るか |
| --- | --- |
| `CRONITOR_API_KEY` | Telemetry 用 API key（権限 `monitor:telemetry`）。収集とクリップで共有。Access の外形プローブでも、Cloudflare Access / Workers のトークンでもない |
| `CRONITOR_FEED_COLLECT_MONITOR_KEY` | 定期収集。cron `0 19 * * *`（04:00 Asia/Tokyo）の feed 収集 enqueue。`count` は対象にした有効情報源数、`error_count` は enqueue 失敗数。`error_count > 0` または例外で `fail`。情報源ごとの取得（feed queue）は見ない。同じ cron の日次ダイジェスト enqueue も見ない |
| `CRONITOR_CLIP_MONITOR_KEY` | クリップ処理。clip queue consumer の 1 バッチ（本番の `max_batch_size` は 1）。`count` はバッチのメッセージ数、`error_count` は終端失敗と不正メッセージ。どちらかがあれば `fail`。`message.retry` の途中は `complete`（まだ終端ではない）。キューが動かない時間は ping しない |

モニターキーの文字列はコードに埋め込まない。Cronitor 側のキーと secret の値を同じにする。例: 収集 `xteink-feed-collect`、クリップ `xteink-clip`。

本番は `wrangler secret put` で上の 3 つを入れる。ローカルは `.dev.vars`。値が空、または API key とモニターキーの片方だけ、のときは送らない。値はここに書かない。

未知のキーへ ping すると Cronitor がモニターを自動作成することがある。Ops は UI で Job モニターを先に 2 本作る（このリポジトリは作らない。secret の値も PR に置かない）。収集は 1 日 1 回（UTC 19:00）の未実行で知らせる。クリップはスケジュール未実行を見ない（クリップが無い時間は異常ではない）。`fail` と、必要なら `metric.duration` / `metric.error_count` の断言は Ops が付ける。アラート先は Access 外形監視と同じでよい。

## Access の経路を変えたときだけ

朝晩の 2 行と、上の Access 外形監視の 2 行に足す。朝晩や、Access と無関係なデプロイでは見ない。

| パス | 認証 | 期待ステータス | いつ |
| --- | --- | --- | --- |
| `GET /opds` | HTTP Basic（`OPDS_USERNAME` / `OPDS_PASSWORD`） | **200**。`*.cloudflareaccess.com` へ飛ばない | Access の経路を変えたときだけ |
| `GET /clip/recent` | Access のセッションなし | **302**。`Location` のホストが `*.cloudflareaccess.com` | 同上 |
| `GET /books` | Access のセッションなし | **302**。`Location` のホストが `*.cloudflareaccess.com` | 同上（外形監視と同じ期待） |
| `GET /digest/send` | なし | Access に飛ばない。Worker の **404** | 同上（外形監視と同じ期待） |

Basic で守った `/opds` は Access のログインに入らない。正しい Basic を付けたとき Worker は **200** を返す。カタログ本文は見ない。認証が無い、または Basic が一致しないときは Worker 自身の **401** で、それは朝晩の行である。`*.cloudflareaccess.com` へ飛ぶ（多くは **302**）のは不合格。Access が経路を飲んでいる。ユーザー名とパスワードの値はここに書かない。

`GET /clip/recent` の **302** は、その HTML が Access 越しに守られている印。セッション無しで Worker の **401** が返るときは、Access の対象から外れている。
