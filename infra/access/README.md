# Access（Terraform）

Cloudflare Access の骨格。適用手順とフェーズ1で変えないパスは [docs/access-as-code.md](../../docs/access-as-code.md)。

`terraform apply` はしない。API トークンは作らない。トークンも state もリポジトリに置かない。CI はこのディレクトリを実行しない。
