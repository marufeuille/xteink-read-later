# Access（Terraform）

Cloudflare Access の定義。パスと Bypass の正本は [docs/access-as-code.md](../../docs/access-as-code.md)。

`terraform apply` は Ops が手元で行う。使うのは Access 用の API トークン（環境変数 `CLOUDFLARE_API_TOKEN`）。Workers 用トークンは流用しない。トークンも state もリポジトリに置かない。CI はこのディレクトリを実行しない。GitHub Actions で apply しない。
