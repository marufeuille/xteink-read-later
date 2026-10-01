# Access（Terraform）

Cloudflare Access の定義。パス、ID、移行、戻し方の正本は [docs/access-as-code.md](../../docs/access-as-code.md)。

state は Cloudflare R2 の S3 互換 backend。手元と GitHub Actions は同じオブジェクトを使う。トークンも state もリポジトリに置かない。

| 項目 | 値 |
| --- | --- |
| バケット | `xteink-read-later-tfstate` |
| キー | `access/terraform.tfstate` |
| ロック | `access/terraform.tfstate.tflock` |
| エンドポイント | `https://ee3ee1637004c64111483d968da0f5b1.r2.cloudflarestorage.com` |
| region | `auto` |

Workers の記事バケット `xteink-read-later-articles` とは別。CI はこのバケットを作らない。

| 環境変数 | GitHub Actions secret | 中身 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `TF_CLOUDFLARE_API_TOKEN` | Access: Apps and Policies の Read と Edit。Workers deploy の secret `CLOUDFLARE_API_TOKEN` とは別 |
| `AWS_ACCESS_KEY_ID` | `TF_STATE_ACCESS_KEY_ID` | 上のバケットの S3 アクセスキー ID（Object Read & Write） |
| `AWS_SECRET_ACCESS_KEY` | `TF_STATE_SECRET_ACCESS_KEY` | 上のシークレット |

`infra/access/**` を変える PR では `.github/workflows/access-terraform.yml` が `terraform plan` し、結果を PR コメントと artifact `access-terraform-plan` に出す。`main` へのマージでは同じ workflow が `terraform apply -auto-approve` する。手動承認の Environment は無い。`workflow_dispatch` も無い。

plan が次の create / destroy / replace を出したら、import 漏れか作り直し。マージしない。state にポリシー 2 つと Allow アプリが無いとき、apply は実行しない。Bypass アプリは `digest_send` か、`moved.tf` を apply する前の `digest_send_bypass` のどちらか一方があればよい。両方あるときは apply しない。

- `cloudflare_zero_trust_access_policy.family`
- `cloudflare_zero_trust_access_application.xteink_read_later`
- `cloudflare_zero_trust_access_policy.digest_send_bypass`
- `cloudflare_zero_trust_access_application.digest_send`

`moved.tf` は application の `digest_send_bypass` を `digest_send` に移す。plan の `has moved to` と `0 to add, 0 to change, 0 to destroy` は作り直しではない。ポリシーのアドレスは変えない。

バケット作成と、手元の state を `terraform init -migrate-state` で移す作業は Ops。移す前に手元で `terraform plan` を見る。差分が残ったまま Actions の apply を再実行しない。
