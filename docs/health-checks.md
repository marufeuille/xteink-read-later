# 本番スモークの合否

ステータスだけで切る。朝晩と、Access の外形監視と、Access の経路を変えたあとに使う。カタログの中身、秘密の値、ダッシュボードのクリック手順は書かない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。末尾スラッシュは付けない。リダイレクトは追わない。最初のステータスを見る。

パスの正本は [access-as-code.md](access-as-code.md)。ログの日次は [workers-logs.md](workers-logs.md)。OPDS の識別子は [daily-opds.md](daily-opds.md)。外形監視のコード正本は [infra/checkly/](../infra/checkly/)。

## いつやるか

| 枠 | 何を見るか | 誰が・いつ |
| --- | --- | --- |
| 朝晩 | `/opds` 401 と `/candidates.json` Bearer 200 | Ops ルーチン folder `xteink`（8:39 / 20:39 JST）。Access パスは見ない |
| Access 外形監視（別監視） | `/books` 壁あり・`/digest/send` 壁なし | **Checkly**（Hobby $0、**as-code**）が外から定期プローブ。落ちたらメール等で Ops が Linear を切る。朝晩とは別 |
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

**採用スタック:** [Checkly](https://www.checklyhq.com/) **Hobby（$0）** + **CLI constructs（as-code）**。定義の正本は [`infra/checkly/`](../infra/checkly/)。ダッシュボードでモニターを手作りしない（アカウントと API key の作成だけ UI）。`npx checkly deploy` で反映する。Cloudflare Health Checks は Free では不可（Pro+）。UptimeRobot Free はカスタム 404=UP が有料で `/digest/send` に向かない。Cronitor も無料で断言できるが、チームは Checkly as-code を選んだ。

### 期待（正本）

| パス | 認証 | 期待 | 不合格の例 |
| --- | --- | --- | --- |
| `GET /books` | Access のセッションなし | **302**。`Location` に `cloudflareaccess.com` を含む。リダイレクトは追わない | Worker の **401** / **200** / 5xx、Access 以外への 302、タイムアウト |
| `GET /digest/send` | なし | Access に飛ばない。Worker の **404** | `*.cloudflareaccess.com` へのリダイレクト、5xx、タイムアウト |

いまのチームのログインホストは `marufeuille.cloudflareaccess.com`。`GET /digest/send` のパス単体に Worker ルートは無く、届いたときのステータスは **404**。署名付きの `/digest/send/:candidateId/:expires/:token` は監視しない。

### Checkly as-code（Masahiro がアカウント作成後）

1. Hobby アカウントと API key / Account ID を用意（手順は Ops の setup メモ。値はリポジトリに書かない）。
2. `cd infra/checkly && npm install`
3. 環境に `CHECKLY_API_KEY` と `CHECKLY_ACCOUNT_ID` を置いて `npx checkly test` → 緑を確認 → `npx checkly deploy`
4. Alert Email を Masahiro へ。webhook / 追加メールで Ops → Linear は後から可。
5. GitHub Actions からの自動 deploy と Secrets（`CHECKLY_API_KEY` 等）は後続。この文書では workflow を要求しない。

論理 ID（コード上）:

- `xteink-books-access-wall` — status 302 + header `Location` contains `cloudflareaccess.com`、`followRedirects: false`
- `xteink-digest-send-no-access` — status equals 404、`followRedirects: false`（「request should fail」は使わない）

詳細は [infra/checkly/README.md](../infra/checkly/README.md)。

### 異常のとき（Ops）

既存 Ops 通知に揃える。Marufeuille / Xteink Read Later に Linear を切る（どの check か・観測ステータス・`Location` ホスト・次の手）。token / パスワードは書かない。

直し方の目安:

1. [access-as-code.md](access-as-code.md) の Allow / Bypass と本番 Zero Trust が一致しているか見る。
2. `/books` が壁なし → Allow の destinations に `/books`（と `/books/` / `/books/*`）があるか。消えていれば Access 側を戻す。
3. `/digest/send` が壁あり → Bypass アプリ（ホスト + `/digest/send`）が生きているか。親の `/digest` Allow が配下を飲み込んでいないか。
4. 直したあと Checkly が緑に戻ることと、朝晩の `/opds` 401 が壊れていないことを確認する。

### なぜ Checkly（as-code）か（短い比較）

| 候補 | 判定 |
| --- | --- |
| **Checkly Hobby + CLI（採用）** | 無料で status / header 断言可。302+Location と 404 をそのまま「正常」にできる。定義を git でレビューできる。メール/Slack/webhook。チーム選定 |
| Cronitor Hacker | 同様に無料で断言可だが、今回は採用しない（UI 主導になりやすい） |
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
