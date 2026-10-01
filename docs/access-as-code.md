# Cloudflare Access をコードで持つ

Zero Trust の self-hosted アプリは 2 つ。Allow の本体と、まとめ QR 用の Bypass。2026-10-01 の本番に合わせてある。

定義は [infra/access](../infra/access)。state は Cloudflare R2。手元と GitHub Actions は同じ state を使う。

`infra/access/**`（と Access の workflow / スクリプト）を変える pull request では `terraform plan` が走り、結果が PR コメントと artifact に出る。`main` へのマージでは `terraform apply -auto-approve` が自動で走る。手動承認の Environment は無い。`workflow_dispatch` だけを apply の入口にはしない。

トークンの値はリポジトリに書かない。Workers 用の `CLOUDFLARE_API_TOKEN` は使わない。

plan が既存アプリやポリシーの create / destroy / replace を出したら import 漏れか作り直し。その PR はマージしない。空の state に対する apply は workflow が止める。

## 適用済み（MAR-142）

2026-10-01、Masahiro の承認を経て Ops が本番へ apply した。[MAR-142](https://linear.app/marufeuille/issue/MAR-142)。

この apply で実体がこう変わった。

- `/books`、`/books/`、`/books/*` を Allow に足した
- `/digest/*` を Allow から外した。ワイルドカードのままだと `/digest/send` まで Allow になる
- `/digest/send` 用の Bypass アプリとポリシーを足した

適用前は `/books` をコードに足さず、この骨格では apply しない、としてあった。承認後の正本は下のパス一覧。

以後のパス変更は、PR の plan を見て `main` にマージする。マージすると apply される。plan がアプリやポリシーの作成を出したら import 漏れなのでマージしない。

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

- Terraform **1.10 以上**。CI は **1.14.9**（`hashicorp/setup-terraform@v4`）。手元も 1.14.9 に揃える。`use_lockfile` と R2 向けの backend 引数は 1.10 未満では読めない
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
- トークンの値はリポジトリに書かない。作成した値はこの文書に貼らない
- GitHub Actions の Workers 用 secret `CLOUDFLARE_API_TOKEN` は流用しない。Wrangler の secret は変えない。Access のジョブは secret `ACCESS_CLOUDFLARE_API_TOKEN` を環境変数 `CLOUDFLARE_API_TOKEN` に入れてから Terraform を起動する
- トークンはシェルと GitHub Actions の secret だけ。`api_token` 変数は無い
- state は R2。メールアドレスとリソース ID が入る。`terraform.tfstate` は gitignore のままコミットしない

## Remote state（R2）

backend は `infra/access/versions.tf` の `backend "s3"`。非秘密の値はコードに書く。認証は環境変数だけ（partial configuration の秘密部分は環境変数に寄せ、`-backend-config` ファイルは使わない）。

| 項目 | 値 |
| --- | --- |
| バケット | `xteink-read-later-tfstate` |
| キー | `access/terraform.tfstate` |
| ロックオブジェクト | `access/terraform.tfstate.tflock`（`use_lockfile = true`） |
| region | `auto` |
| エンドポイント | `https://ee3ee1637004c64111483d968da0f5b1.r2.cloudflarestorage.com` |
| Account ID | `ee3ee1637004c64111483d968da0f5b1` |

R2 は AWS の STS と metadata を持たない。backend は `skip_credentials_validation`、`skip_region_validation`、`skip_requesting_account_id`、`skip_metadata_api_check`、`skip_s3_checksum`、`use_path_style` を有効にする。`encrypt` は false（R2 側の保存時暗号化に任せ、SSE ヘッダは送らない）。

Workers の記事バケット `xteink-read-later-articles` とは別物。デプロイジョブの `ensure-r2-bucket.sh` は state バケットを作らない。

ロックは S3 の条件付き書き込みに依存する。R2 が拒否するときは plan がロック取得で落ちる。そのときはトークンが `access/terraform.tfstate.tflock` を消せるかを見る。GitHub Actions は concurrency group `access-terraform` で plan と apply を直列にする。手元の apply と CI の重なりはロックが受ける。

### GitHub Actions secrets

リポジトリの Actions secrets。Environment は使わない。値は書かない。

| Secret | ジョブ内の環境変数 | 中身 |
| --- | --- | --- |
| `ACCESS_CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | Access: Apps and Policies の Read と Edit。Workers 用トークンではない |
| `ACCESS_TF_STATE_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | バケット `xteink-read-later-tfstate` に絞った R2 API トークンの Access Key ID。権限は Object Read & Write |
| `ACCESS_TF_STATE_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | 上の Secret Access Key |

Account ID は secret にしない。workflow の `TF_VAR_account_id` と `terraform.tfvars.example` にある。Workers 用 secret `CLOUDFLARE_ACCOUNT_ID` は読まない。

fork からの pull request には secret を渡さない（`pull_request` であり `pull_request_target` ではない）。fork では plan ジョブは走らない。

手元では同じ 3 つの環境変数に加え、次を置く。

```bash
export AWS_EC2_METADATA_DISABLED=true
export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
export AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
```

`TF_LOG` と `set -x` は付けない。値を echo しない。

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

Google の login method が Allow ポリシーの Require にいる場合、UUID が無いので `require` は `ignore_changes` に入れ、空の設定で消さない。Include 側に login method がいると plan が `include` を出す。そのときはマージせず、実体に合わせてから plan をやり直す。Bypass の Include は everyone のままにする。

## state を R2 へ移す（Ops）

バケット作成と state の移行は、このリポジトリの GitHub Actions ではやらない。secret とバケットが無い間、plan と apply は失敗で終わる。失敗はアプリを作らない。

安全な順。

1. R2 にバケット `xteink-read-later-tfstate` を作る。ダッシュボードか、バケットを作れるトークンで一度だけ。Access 用トークンにも、state 用の Object Read & Write にも、バケット作成は含めない。Workers の `ensure-r2-bucket.sh` は使わない。
2. そのバケットに絞った R2 API トークン（Object Read & Write）を作る。Access Key ID と Secret Access Key をパスワード管理に置く。リポジトリとチャットログには貼らない。
3. Access 用 API トークン（Apps and Policies の Read と Edit）を別に作る。Workers 用トークンを流用しない。
4. いま手元にある `infra/access/terraform.tfstate` を、リポジトリの外に控える。控えはコミットしない。
5. 上の環境変数をシェルに置く。`infra/access` で `cp terraform.tfvars.example terraform.tfvars`。
6. Terraform 1.14.9 で、手元の state があり R2 のオブジェクトがまだ無いときだけ `terraform init -migrate-state -input=false`。R2 にすでに state があるとき、空の手元 state で migrate しない。CI は `-migrate-state` を付けない。
7. `terraform state list` に次の 4 行があること。
   - `cloudflare_zero_trust_access_policy.family`
   - `cloudflare_zero_trust_access_application.xteink_read_later`
   - `cloudflare_zero_trust_access_policy.digest_send_bypass`
   - `cloudflare_zero_trust_access_application.digest_send`
8. `terraform plan` を見る。`No changes` であること。create / destroy / replace、precedence、include、名前の差分が残っているときは、Actions の apply を再実行しない。コードか `policy_precedence` を実体に合わせ、その差分の PR plan を見てからマージする。
9. GitHub Actions に 3 つの secret を入れる。
10. secret を入れたあと、開いている PR の Access Terraform を再実行し、コメントの plan が手元と同じであることを見てからマージする。

手元の state を失くしているときは migrate できない。下の import を、空の remote state に対して行う。import が終わる前に apply しない。

## import

`infra/access` で実行する。backend の init のあと、ポリシーが先、アプリが後。Allow と Bypass の両方。両方終わる前に apply しない。plan が作成を出したら import 漏れなので apply しない（新しいアプリやポリシーが増える）。

```bash
cd infra/access
terraform init -input=false
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

`CLOUDFLARE_API_TOKEN` は上のコマンドの前にシェルへ置く。ファイルには書かない。Access 用のトークンであり、Workers 用ではない。R2 の `AWS_ACCESS_KEY_ID` と `AWS_SECRET_ACCESS_KEY` も同じシェルに置く。import は remote state に書く。

ID の形は provider 5.26.0 の import ドキュメントどおり。アプリは account スコープなので `accounts/<account_id>/<app_id>`。ポリシーは `<account_id>/<policy_id>`。

## plan と apply

workflow は `.github/workflows/access-terraform.yml`。

- pull request: `terraform validate`（backend なし）のあと、同一リポジトリの head だけ `terraform plan`。失敗ならそのジョブは失敗する。plan 本文は marker `<!-- access-terraform-plan -->` のコメントを更新し、artifact `access-terraform-plan` にも出す。長いコメントは切る
- `main` への push: 同じパスの変更だけ `terraform apply -input=false -auto-approve`。その前に `terraform plan -out=tfplan` し、保存した plan を apply する
- 取り込み済み 4 アドレスが `terraform state list` に無いとき、apply しない
- plan がこの 4 つの create / destroy / replace を含むとき、plan ジョブは失敗し、apply もしない
- それ以外の更新（パスの増減など）は、PR で見た plan がマージされると main で apply される

手元:

```bash
terraform plan
```

import 済みで、コードが上の実体と同じなら差分は無い。

| plan の差分 | 扱い |
| --- | --- |
| パスの増減 | 意図した変更なら PR の plan を見てマージする。main が apply する |
| `precedence` | `terraform.tfvars` に実体の `policy_precedence` を書き、plan から消す。残したままマージすると apply がその値を書く。CI は既定の `1` を使う |
| `name` / `domain` | 実体の文字列に `main.tf` を合わせる。名前を変える差分はマージしない |
| Allow の `include` | 上の 2 メールと違うときはマージしない |
| Bypass の `include` | everyone 以外ならマージしない |
| アプリの `policies` から `decision` や `include` が null になる | 再利用ポリシーの id と precedence だけを書く構成で、provider がルールをインラインとして読んでいる。マージしない |
| session や cookie など | `ignore_changes` にある。ここに無い項目が null に戻る差分なら、実体の値を書くか `ignore_changes` に足す。戻す差分はマージしない |
| アプリやポリシーの作成 | import していない。マージしない。workflow も失敗させる |
| destroy / replace | 作り直し。マージしない。workflow も失敗させる |

## 戻す、再 apply

`terraform destroy` は使わない。アプリとポリシーは `prevent_destroy`。

- 定義を戻すには、戻したコードの PR をマージする。`main` の apply が同じ remote state に対してその定義を書く
- Actions が落ちているときは、同じ環境変数で手元から `terraform plan` を見て、意図どおりなら `terraform apply`。別の local state は作らない（`terraform init` は R2 を向く）
- 再実行は、`main` の Access Terraform の run を Re-run する。パスが変わらない空コミットでは `on.paths` に当たらず走らない
- 初回の Re-run の前に、手元の `terraform plan` が `No changes` か、意図した差分だけであることを確認する。precedence や include が残ったまま Re-run しない
- state を壊したときは、移行前にリポジトリの外へ控えた `terraform.tfstate` だけを、同じ backend に対して `terraform state push` で戻す。控えが無いファイルは push しない。push のあと plan が create を出したら apply しない

## ドリフト

lock ファイルの provider のまま plan する。`terraform init -upgrade` で provider を上げない（上げると差分の意味が変わる）。

差分がパス、メール、アプリ名、ドメインなら、ダッシュボードがコードより先に変わった印。`/books` をコードから消したり、Bypass アプリを消して差分を埋めない。`/digest/*` を足すと `/digest/send` の QR が Allow に戻り得る。

PR の plan がこのドリフトを見せる。意図しない差分はマージしない。マージすると main が apply する。

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
| `infra/access/versions.tf` | provider `~> 5.24` と R2 の backend |
| `infra/access/terraform.tfvars.example` | account id の例。トークンは無い |
| `infra/access/.terraform.lock.hcl` | provider の固定。秘密は無い |
| `infra/access/.gitignore` | state、tfvars、plan ファイル |
| `.github/workflows/access-terraform.yml` | PR の plan と main の apply |
| `.github/scripts/access-terraform.sh` | 認証の有無、plan の危険な差分、コメント本文。値は出さない |
