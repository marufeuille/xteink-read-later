# Cloudflare Access をコードで持つ

Zero Trust の self-hosted アプリ（1つ）と Allow ポリシーの正本。2026-09-30（JST）にダッシュボードから写した実体を import し、パス一覧を欠かさないことで `terraform plan` の差分をなくす。

この変更では **適用しない**。CI に Cloudflare の認証情報は置かない。`terraform apply` は、import 済みで plan が空になったあと、パスやメールを変える意図が別にできたときだけ手元で行う。

定義は [infra/access](../infra/access)。

## フェーズ1で編集してよいパス

この PR では値を変えない。今後の編集対象はここだけ。

- `/candidates`、`/candidates/`、`/candidates/*`
- `/clip/web`、`/clip/web/`、`/clip/web/*`
- `/clip/recent`、`/clip/recent/`（`/clip/recent/*` は無い）

## フェーズ1で変えないパス

今日の実体にある。state に残すので、リソースから消さない。消すと plan が差分になり、apply すると保護が外れる。

- `/sources`、`/sources/`、`/sources/*`
- `/digest`、`/digest/`、`/digest/*`

`/books` は 2026-09-30 の実体に無い。足さない。

README の初回手順は `/books` を載せ、`/digest` を載せていない。コードはダッシュボードの実体に合わせてある。README の手順本文は今回変えていない。

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
  - 対象アカウントだけに絞る
- この PR ではトークンを作らない。値もリポジトリに書かない
- GitHub Actions の Workers 用 `CLOUDFLARE_API_TOKEN` は流用しない。Wrangler の secret は変えない
- トークンはシェルだけ。`api_token` 変数は無い
- state は手元の `infra/access/terraform.tfstate`（gitignore）。リモート backend は置かない。state にはメールアドレスとリソース ID が入るのでコミットしない

## 実体（2026-09-30 JST）

| 項目 | 値 |
| --- | --- |
| Account ID | `ee3ee1637004c64111483d968da0f5b1` |
| Team | `marufeuille` |
| アプリ名 | `xteink-read-later.marufeuille.workers.dev/candidates` |
| 種別 | self-hosted。アプリは 1 つ |
| Application ID | `00a3a478-9f02-4f1e-b3b4-157bf735f9d4` |
| ホスト | `xteink-read-later.marufeuille.workers.dev` |
| ポリシー名 | `家族only` |
| Policy ID | `b42cf29d-d046-45a6-a6fb-4d6e9d36eb56` |
| Action | Allow |
| Include | `marufeuille@gmail.com`、`mc.cky.ns0226@gmail.com` |
| ログイン | Google。IdP の UUID は未記録 |

Google の login method がポリシーの Require にいる場合、UUID が無いので `require` は `ignore_changes` に入れ、空の設定で消さない。Include 側に login method がいると plan が `include` を出す。そのときは apply せず、実体に合わせてから plan をやり直す。

## import

`infra/access` で実行する。ポリシーが先、アプリが後。両方終わる前に apply しない。plan が作成を出したら import 漏れなので apply しない（新しいアプリやポリシーが増える）。

```bash
cd infra/access
terraform init
cp terraform.tfvars.example terraform.tfvars

terraform import cloudflare_zero_trust_access_policy.family \
  'ee3ee1637004c64111483d968da0f5b1/b42cf29d-d046-45a6-a6fb-4d6e9d36eb56'

terraform import cloudflare_zero_trust_access_application.xteink_read_later \
  'accounts/ee3ee1637004c64111483d968da0f5b1/00a3a478-9f02-4f1e-b3b4-157bf735f9d4'
```

`CLOUDFLARE_API_TOKEN` は上のコマンドの前にシェルへ置く。ファイルには書かない。

ID の形は provider 5.26.0 の import ドキュメントどおり。アプリは account スコープなので `accounts/<account_id>/<app_id>`。ポリシーは `<account_id>/<policy_id>`。

## plan と apply

```bash
terraform plan
```

差分が無いこと。あるときは apply しない。

| plan の差分 | 扱い |
| --- | --- |
| パスの増減 | `main.tf` の `protected_paths` を実体の順に合わせる。`/sources*` と `/digest*` は消さない |
| `precedence` | `terraform.tfvars` に実体の `policy_precedence` を書く。その差分は apply しない |
| `name` / `domain` | 実体の文字列に `main.tf` を合わせる。apply で名前を変えない |
| `include` | 上の 2 メールと違うときは止める |
| アプリの `policies` から `decision` や `include` が null になる | 再利用ポリシーの id と precedence だけを書く構成で、provider がルールをインラインとして読んでいる。apply しない |
| session や cookie など | `ignore_changes` にある。ここに無い項目が null に戻る差分なら、実体の値を書くか `ignore_changes` に足す。戻す apply はしない |

CI では `terraform plan` も `terraform apply` もしない。

## ドリフト

lock ファイルの provider のまま、手元で `terraform plan` を繰り返す。`terraform init -upgrade` で provider を上げない（上げると差分の意味が変わる）。

差分がパス、メール、アプリ名、ドメインなら、ダッシュボードがコードより先に変わった印。フェーズ1で凍結したパスをコードから消して差分を消さない。

定期 plan を GitHub Actions に載せる変更は、トークンをリポジトリの secret に足すことになるので、この PR では作らない。

## 将来 apply したあとの確認

Access のログインになること。

- `https://xteink-read-later.marufeuille.workers.dev/candidates`
- `https://xteink-read-later.marufeuille.workers.dev/clip/web`
- `https://xteink-read-later.marufeuille.workers.dev/clip/recent`

Access のログイン（`marufeuille.cloudflareaccess.com`）に飛ばないこと。

- `/opds`（Basic のまま）
- `POST /clip`（Bearer のまま）

`/digest*` は今 Access の対象だが、フェーズ1では外さない。外れたように見えても、この骨格の apply でパスを削らない。`/books` は対象外。

ステータスだけの合否は [health-checks.md](health-checks.md)。朝晩と、Access を変えていないデプロイではそこの朝晩の 2 行だけ。経路を変えたときだけ追加の 2 行も見る。`POST /clip` が Access に飛ばないことはこの節のまま（ヘルス表には載せない）。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `infra/access/main.tf` | アプリとポリシー。パスの並びは実体どおり |
| `infra/access/variables.tf` | `account_id`、`policy_precedence` |
| `infra/access/terraform.tfvars.example` | account id の例。トークンは無い |
| `infra/access/versions.tf` | provider `~> 5.24` |
| `infra/access/.terraform.lock.hcl` | provider の固定。秘密は無い |
