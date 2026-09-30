terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }
}

# トークンは環境変数 CLOUDFLARE_API_TOKEN。引数にしない（tfvars に書けないようにする）。
provider "cloudflare" {}
