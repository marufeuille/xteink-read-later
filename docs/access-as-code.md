# Cloudflare Access をコードで持つ

Zero Trust の self-hosted アプリは 2 つ。Allow の本体と、まとめ QR 用の Bypass。2026-10-01 の本番に合わせてある。

定義は [infra/access](../infra/access)。

CI に Cloudflare の認証情報は置かない。`terraform apply` は Ops が手元で行う。トークンはリポジトリに書かない。GitHub Actions で apply しない。

## 適用済み（MAR-142）

2026-10-01、Masahiro の承認を経て Ops が本番へ apply した。[MAR-142](https://linear.app/marufeuille/issue/MAR-142)。

この apply で実体がこう変わった。

- `/books`、`/books/`、`/books/*` を Allow に足した
- `/digest/*` を Allow から外した。ワイルドカードのままだと `/digest/send` まで Allow になる
- `/digest/send` 用の Bypass アプリとポリシーを足した

適用前は `/books` をコードに足さず、この骨格では apply しない、としてあった。承認後の正本は下のパス一覧。

以後のパス変更も、apply は手元だけ。plan がアプリやポリシーの作成を出したら import 漏れなので apply しない。

## パス（Allow の本体）

並びはこの順。

- `/candidates`、`/candidates/`、`/candidates/*`
- `/sources`、`/sources/`、`/sources/*`
- `/clip/web`、`/clip/web/`、`/clip/web/*`
- `/digest`、`/digest/`（`/digest/*` は無い）
- `/clip/recent`、`/clip/recent/`（`/clip/recent/*` は無い）
- `/books`、`/books/`、`/books/*`

`/candidates.json` と `/sources.json` は含めない。

## Bypass（`/digest/send`）

Cloudflare は親 `/digest` の配下を継承する。`/digest/*` を外しても `/digest/send` は親に覆われる。より具体的な Bypass アプリが上書きするので、QR は Google ログインなしで開く。

アプリ名は `xteink-read-later.marufeuille.workers.dev/digest/send`。宛先はこの 2 つだけ。

- `/digest/send`
- `/digest/send/`

ポリシー名は `digest/send Bypass`。decision は `bypass`。Include は everyone。

## 前提

- Terraform 1.5 以上
- プロバイダ `cloudflare/cloudflare` `~> 5.24`。lock は **5.26.0**（2026-09-24）。`terraform init -upgrade` で上げない
  - リソースは `cloudflare_zero_trust_access_application` と `cloudflare_zero_trust_access_policy`
  - import の ID 形式は [v5.26.0 のドキュメント](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.26.0/docs/resources/zero_trust_access_application.md) で確認した
  - パスは `destinations`（`type = "public"` の `uri`）。`self_hosted_domains` は 2025-11-21 で非推奨
  - `terraform validate` は `ignore_changes` に残した `self_hosted_domains` を非推奨と警告する。実体の古いフィールドを空に戻さないため残している
  - provider 5.24 以降、ポリシーの `session_duration` は省略時の既定 `24h` を持たない。実体の値は未記録なので `ignore_changes` に入れ、`24h` とは書かない
- 環境変数 `CLOUDFLARE_API_TOKEN`
  - ダッシュボードの権限名: Account の **Access: Apps and Policies** の **Read** と **Edit**
  - provider ドキュメントの名前: `Access: Apps and Policies Read` と `Write`
  - 対象アカウントだけに絞る。Workers 用トークンは流用しない
- トークンの値はリポジトリに書かない。作成手順はここに置かない
- GitHub Actions の Workers 用 `CLOUDFLARE_API_TOKEN` は流用しない。Wrangler の secret は変えない
- トークンはシェルだけ。`api_token` 変数は無い
- state は手元の `infra/access/terraform.tfstate`（gitignore）。リモート backend は置かない。state にはメールアドレスとリソース ID が入るのでコミットしない

## 実体（2026-10-01）

共通。

| 項目 | 値 |
| --- | --- |
| Account ID | `ee3ee1637004c64111483d968da0f5b1` |
| Team | `marufeuille` |
| ホスト | `xteink-read-later.marufeuille.workers.dev` |

Allow の本体。

| 項目 | 値 |
| --- | --- |
| アプリ名 | `xteink-read-later.marufeuille.workers.dev/candidates` |
| 種別 | self-hosted |
| Application ID | `00a3a478-9f02-4f1e-b3b4-157bf735f9d4` |
| ポリシー名 | `家族only` |
| Policy ID | `b42cf29d-d046-45a6-a6fb-4d6e9d36eb56` |
| Action | Allow |
| Include | `marufeuille@gmail.com`、`mc.cky.ns0226@gmail.com` |
| ログイン | Google。IdP の UUID は未記録 |

Bypass（まとめ QR）。

| 項目 | 値 |
| --- | --- |
| アプリ名 | `xteink-read-later.marufeuille.workers.dev/digest/send` |
| 種別 | self-hosted |
| Application ID | `197e967e-d9ef-44c8-8de6-65a9db82fe33` |
| ポリシー名 | `digest/send Bypass` |
| Policy ID | `a45dd0ec-3827-4332-a0f1-eca7cdf64000` |
| Action | Bypass |
| Include | everyone |

Google の login method が Allow ポリシーの Require にいる場合、UUID が無いので `require` は `ignore_changes` に入れ、空の設定で消さない。Include 側に login method がいると plan が `include` を出す。そのときは apply せず、実体に合わせてから plan をやり直す。Bypass の Include は everyone のままにする。

## import

`infra/access` で実行する。ポリシーが先、アプリが後。Allow と Bypass の両方。両方終わる前に apply しない。plan が作成を出したら import 漏れなので apply しない（新しいアプリやポリシーが増える）。

```bash
cd infra/access
terraform init
cp terraform.tfvars.example terraform.tfvars

terraform import cloudflare_zero_trust_access_policy.family \
  'ee3ee1637004c64111483d968da0f5b1/b42cf29d-d046-45a6-a6fb-4d6e9d36eb56'

terraform import cloudflare_zero_trust_access_application.xteink_read_later \
  'accounts/ee3ee1637004c64111483d968da0f5b1/00a3a478-9f02-4f1e-b3b4-157bf735f9d4'

terraform import cloudflare_zero_trust_access_policy.digest_send_bypass \
  'ee3ee1637004c64111483d968da0f5b1/a45dd0ec-3827-4332-a0f1-eca7cdf64000'

terraform import cloudflare_zero_trust_access_application.digest_send \
  'accounts/ee3ee1637004c64111483d968da0f5b1/197e967e-d9ef-44c8-8de6-65a9db82fe33'
```

`CLOUDFLARE_API_TOKEN` は上のコマンドの前にシェルへ置く。ファイルには書かない。Access 用のトークンであり、Workers 用ではない。

ID の形は provider 5.26.0 の import ドキュメントどおり。アプリは account スコープなので `accounts/<account_id>/<app_id>`。ポリシーは `<account_id>/<policy_id>`。

## plan と apply

```bash
terraform plan
```

import 済みで、コードが上の実体と同じなら差分は無い。

| plan の差分 | 扱い |
| --- | --- |
| パスの増減 | `main.tf` の `protected_paths` と `digest_send_paths` を実体の順に合わせる。意図した変更で、承認があるときだけ apply する |
| `precedence` | `terraform.tfvars` に実体の `policy_precedence` を書く。Allow と Bypass は同じ変数。その差分は apply しない |
| `name` / `domain` | 実体の文字列に `main.tf` を合わせる。apply で名前を変えない |
| Allow の `include` | 上の 2 メールと違うときは止める |
| Bypass の `include` | everyone 以外なら止める |
| アプリの `policies` から `decision` や `include` が null になる | 再利用ポリシーの id と precedence だけを書く構成で、provider がルールをインラインとして読んでいる。apply しない |
| session や cookie など | `ignore_changes` にある。ここに無い項目が null に戻る差分なら、実体の値を書くか `ignore_changes` に足す。戻す apply はしない |
| アプリやポリシーの作成 | import していない。apply しない |

CI では `terraform plan` も `terraform apply` もしない。

## ドリフト

lock ファイルの provider のまま、手元で `terraform plan` を繰り返す。`terraform init -upgrade` で provider を上げない（上げると差分の意味が変わる）。

差分がパス、メール、アプリ名、ドメインなら、ダッシュボードがコードより先に変わった印。`/books` をコードから消したり、Bypass アプリを消して差分を埋めない。`/digest/*` を足すと `/digest/send` の QR が Allow に戻り得る。

定期 plan を GitHub Actions に載せる変更は、トークンをリポジトリの secret に足すことになるので作らない。

## 適用後の確認（2026-10-01、セッションなし）

Access のログイン（`*.cloudflareaccess.com` への **302**）になること。

- `GET /books`
- `GET /candidates`
- `GET /clip/web`
- `GET /clip/recent`

Access に飛ばないこと。

- `GET /digest/send` は Worker の **404**。Access のリダイレクトは無い。パス単体にルートは無い。QR の実 URL は `/digest/send/:candidateId/:expires/:token`
- `GET /opds` は Worker の **401**（Basic）。Access ではない
- `POST /clip` は Bearer のまま。Access に飛ばない

ステータスだけの合否は [health-checks.md](health-checks.md)。朝晩と、Access を変えていないデプロイではそこの朝晩の 2 行だけ。経路を変えたときだけ追加の行も見る。`POST /clip` が Access に飛ばないことはこの節のまま（ヘルス表には載せない）。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `infra/access/main.tf` | Allow と Bypass。パスの並びは実体どおり |
| `infra/access/variables.tf` | `account_id`、`policy_precedence` |
| `infra/access/terraform.tfvars.example` | account id の例。トークンは無い |
| `infra/access/versions.tf` | provider `~> 5.24` |
| `infra/access/.terraform.lock.hcl` | provider の固定。秘密は無い |
