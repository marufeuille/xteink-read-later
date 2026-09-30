# 本番スモークの合否

ステータスだけで切る。朝晩と、Access の経路を変えたあとに使う。カタログの中身、秘密の値、ダッシュボードのクリック手順は書かない。

本番 origin は `https://xteink-read-later.marufeuille.workers.dev`。末尾スラッシュは付けない。リダイレクトは追わない。最初のステータスを見る。

パスの正本は [access-as-code.md](access-as-code.md)。ログの日次は [workers-logs.md](workers-logs.md)。OPDS の識別子は [daily-opds.md](daily-opds.md)。

## いつやるか

Access の対象パスや Zero Trust の覆いを変えていないときは、朝晩の表だけ。関係の無いデプロイのあとも同じ。下の追加の表は、Access の経路を変えたデプロイのあとだけ。

## 朝晩

| パス | 認証 | 期待ステータス | いつ |
| --- | --- | --- | --- |
| `GET /opds` | なし | **401** | 朝晩。Access を変えていないデプロイのあと |
| `GET /candidates.json` | `Authorization: Bearer`。値は Worker secret の `CLIP_TOKEN` | **200** で、ボディが JSON | 同上 |

`GET /opds` の 401 は Worker が生きている印。Worker は `WWW-Authenticate: Basic realm="Xteink Read Later"` を付ける。タイムアウト、5xx、`*.cloudflareaccess.com` へのリダイレクト、401 以外は異常。

`GET /candidates.json` はパスが `.json` なので、Bearer があれば JSON を返す。件数や候補の中身は見ない。`CLIP_TOKEN` の値はここに書かない。このパスは Access の対象外。HTML の `/candidates` とは別。

## Access の経路を変えたときだけ

朝晩の 2 行に足す。朝晩や、Access と無関係なデプロイでは見ない。

| パス | 認証 | 期待ステータス | いつ |
| --- | --- | --- | --- |
| `GET /opds` | HTTP Basic（`OPDS_USERNAME` / `OPDS_PASSWORD`） | **200**。`*.cloudflareaccess.com` へ飛ばない | Access の経路を変えたときだけ |
| `GET /clip/recent` | Access のセッションなし | **302**。`Location` のホストが `*.cloudflareaccess.com` | 同上 |

Basic で守った `/opds` は Access のログインに入らない。正しい Basic を付けたとき Worker は **200** を返す。カタログ本文は見ない。認証が無い、または Basic が一致しないときは Worker 自身の **401** で、それは朝晩の行である。`*.cloudflareaccess.com` へ飛ぶ（多くは **302**）のは不合格。Access が経路を飲んでいる。ユーザー名とパスワードの値はここに書かない。

`GET /clip/recent` の **302** は、その HTML が Access 越しに守られている印。いまのチームのログインホストは `marufeuille.cloudflareaccess.com`。セッション無しで Worker の **401** が返るときは、Access の対象から外れている。
