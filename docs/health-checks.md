# 本番スモークの合否

ステータスだけで切る。朝晩と、Access の外形監視と、Access の経路を変えたあとに使う。カタログの中身、秘密の値、ダッシュボードのクリック手順は書かない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。末尾スラッシュは付けない。リダイレクトは追わない。最初のステータスを見る。

パスの正本は [access-as-code.md](access-as-code.md)。ログの日次は [workers-logs.md](workers-logs.md)。OPDS の識別子は [daily-opds.md](daily-opds.md)。

## いつやるか

| 枠 | 何を見るか | 誰が・いつ |
| --- | --- | --- |
| 朝晩 | `/opds` 401 と `/candidates.json` Bearer 200 | Ops ルーチン folder `xteink`（8:39 / 20:39 JST）。Access パスは見ない |
| Access 外形監視（別監視） | `/books` 壁あり・`/digest/send` 壁なし | **Cronitor**（無料 Hacker）が外から定期プローブ。落ちたらメール等で Ops が Linear を切る。朝晩とは別 |
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

**採用スタック:** [Cronitor](https://cronitor.io/) **Hacker（$0 / 5 monitors）**。外から HTTP を叩き、期待と違うときメール（と任意で Slack）で知らせる。Cloudflare Health Checks は Free プランでは使えず対象外。UptimeRobot Free は既定で 404 を DOWN にし、カスタムステータスは有料のため `/digest/send` に向かない。

### 期待（正本）

| パス | 認証 | 期待 | 不合格の例 |
| --- | --- | --- | --- |
| `GET /books` | Access のセッションなし | **302**。`Location` に `cloudflareaccess.com` を含む。リダイレクトは追わない | Worker の **401** / **200** / 5xx、Access 以外への 302、タイムアウト |
| `GET /digest/send` | なし | Access に飛ばない。Worker の **404** | `*.cloudflareaccess.com` へのリダイレクト、5xx、タイムアウト |

いまのチームのログインホストは `marufeuille.cloudflareaccess.com`。`GET /digest/send` のパス単体に Worker ルートは無く、届いたときのステータスは **404**。署名付きの `/digest/send/:candidateId/:expires/:token` は監視しない。

### Cronitor モニター設定（Masahiro がアカウント作成後）

アカウント: [Cronitor Hacker](https://cronitor.io/pricing)（無料・クレカ不要の表記）。モニターは 2 本で足りる。

1. **`xteink-books-access-wall`**
   - Type: Website / HTTP check
   - URL: `https://xteink-read-later.marufeuille.workers.dev/books`
   - Method: GET
   - Follow redirects: **off**
   - Assertions（例）:
     - `response.code = 302`
     - `response.header Location contains cloudflareaccess.com`
   - Schedule: every 5 minutes（Hacker の最短）
2. **`xteink-digest-send-no-access`**
   - URL: `https://xteink-read-later.marufeuille.workers.dev/digest/send`
   - Follow redirects: **off**
   - Assertions:
     - `response.code = 404`
   - Schedule: every 5 minutes

Alerts: Email（必須）を Masahiro の受信箱へ。可能なら Grok Bot の inbox アドレスにも送り、Ops のメール起動ルーチンが Linear を切る。Slack は任意。秘密値は Cronitor に置かない（この 2 本は認証ヘッダ不要）。

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
| **Cronitor Hacker（採用）** | 無料で `response.code` / header 断言可。302+Location と 404 をそのまま「正常」にできる。外から独立。メール/Slack |
| Better Stack Free | `expected_status_code` で 302/404 は可。Location 断言は弱い。同様にサインアップが要る |
| UptimeRobot Free | 既定は 2xx/3xx=UP なので `/books` 302 は可だが、**404 を UP にするカスタムステータスは有料** → `/digest/send` 不向き |
| Cloudflare Health Checks | **Free では不可**（Pro+） |
| Ops curl のみ | 実装は簡単だが、Ops/box 障害時に見逃す。補助にはできるが主検知にはしない |

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
