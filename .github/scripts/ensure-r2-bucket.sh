#!/usr/bin/env bash
# Create wrangler.jsonc ARTICLES bucket if it is missing. Do not print tokens.
set -euo pipefail

BUCKET='xteink-read-later-articles'

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo '::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set as GitHub Secrets.'
  exit 1
fi

list_out="$(npx wrangler r2 bucket list 2>&1)" || {
  echo "$list_out"
  echo '::error::Could not list R2 buckets. CLOUDFLARE_API_TOKEN needs Account permission Workers R2 Storage: Edit (plus Edit Cloudflare Workers).'
  exit 1
}

echo "$list_out"

if echo "$list_out" | grep -Fqw "$BUCKET"; then
  echo "R2 bucket ${BUCKET} already exists"
  exit 0
fi

echo "Creating R2 bucket ${BUCKET}"
if create_out="$(npx wrangler r2 bucket create "$BUCKET" 2>&1)"; then
  echo "$create_out"
  exit 0
fi

echo "$create_out"
if echo "$create_out" | grep -qi 'already exists'; then
  echo "R2 bucket ${BUCKET} already exists"
  exit 0
fi

echo '::error::Failed to create R2 bucket xteink-read-later-articles. Add Account permission Workers R2 Storage: Edit to CLOUDFLARE_API_TOKEN, or create the bucket once with: npx wrangler r2 bucket create xteink-read-later-articles'
exit 1
