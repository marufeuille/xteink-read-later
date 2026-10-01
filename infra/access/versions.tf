terraform {
  # use_lockfile と R2 向けの S3 backend 引数は 1.10 以降。
  # CI は 1.14.9 に固定する。手元もそれに揃える。
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }

  # Cloudflare R2（S3 互換）。バケットとキーとエンドポイントは非秘密。
  # 認証は AWS_ACCESS_KEY_ID と AWS_SECRET_ACCESS_KEY。ファイルにも -backend-config にも書かない。
  # CI は terraform init -migrate-state をしない。移行は手元の一度だけ。
  backend "s3" {
    bucket       = "xteink-read-later-tfstate"
    key          = "access/terraform.tfstate"
    region       = "auto"
    use_lockfile = true
    encrypt      = false

    endpoints = {
      s3 = "https://ee3ee1637004c64111483d968da0f5b1.r2.cloudflarestorage.com"
    }

    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# トークンは環境変数 CLOUDFLARE_API_TOKEN。引数にしない（tfvars に書けないようにする）。
provider "cloudflare" {}
