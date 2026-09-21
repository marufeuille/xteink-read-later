#!/usr/bin/env bash
# Create wrangler.jsonc FEED_QUEUE if it is missing. Do not print tokens.
set -euo pipefail

QUEUE='xteink-read-later-feed'

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo '::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set as GitHub Secrets.'
  exit 1
fi

list_out="$(npx wrangler queues list 2>&1)" || {
  echo "$list_out"
  echo '::error::Could not list Queues. CLOUDFLARE_API_TOKEN needs Account permission Workers Queues: Edit (plus Edit Cloudflare Workers).'
  exit 1
}

echo "$list_out"

if echo "$list_out" | grep -Fqw "$QUEUE"; then
  echo "Queue ${QUEUE} already exists"
  exit 0
fi

echo "Creating queue ${QUEUE}"
if create_out="$(npx wrangler queues create "$QUEUE" 2>&1)"; then
  echo "$create_out"
  exit 0
fi

echo "$create_out"
if echo "$create_out" | grep -qi 'already exists'; then
  echo "Queue ${QUEUE} already exists"
  exit 0
fi

echo '::error::Failed to create queue xteink-read-later-feed. Add Account permission Workers Queues: Edit to CLOUDFLARE_API_TOKEN, or create the queue once with: npx wrangler queues create xteink-read-later-feed'
exit 1
