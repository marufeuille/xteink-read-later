#!/usr/bin/env bash
# Create wrangler.jsonc CANDIDATES D1 database if missing, write its id into
# wrangler.jsonc, and apply migrations. Do not print tokens.
set -euo pipefail

DB_NAME='xteink-read-later-candidates'
PLACEHOLDER_ID='00000000-0000-4000-8000-000000000073'
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/wrangler.jsonc"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo '::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set as GitHub Secrets.'
  exit 1
fi

list_out="$(npx wrangler d1 list --json 2>/dev/null || npx wrangler d1 list 2>&1)" || {
  echo "$list_out"
  echo '::error::Could not list D1 databases. CLOUDFLARE_API_TOKEN needs Account permission D1: Edit (plus Edit Cloudflare Workers).'
  exit 1
}

echo "$list_out"

db_id="$(DB_NAME="$DB_NAME" LIST_OUT="$list_out" node --input-type=module -e '
const name = process.env.DB_NAME
const raw = process.env.LIST_OUT ?? ""
let id = ""
try {
  const parsed = JSON.parse(raw)
  const rows = Array.isArray(parsed) ? parsed : parsed?.result ?? parsed?.databases ?? []
  for (const row of rows) {
    if (row?.name === name) {
      id = String(row.uuid ?? row.id ?? "")
      break
    }
  }
} catch {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = raw.match(new RegExp("([0-9a-f-]{36})\\s+\\|\\s+" + escaped, "i"))
    ?? raw.match(new RegExp(escaped + "[^0-9a-f]*([0-9a-f-]{36})", "i"))
  if (match) id = match[1]
}
process.stdout.write(id)
')"

if [[ -z "$db_id" ]]; then
  echo "Creating D1 database ${DB_NAME}"
  if ! create_out="$(npx wrangler d1 create "$DB_NAME" 2>&1)"; then
    echo "$create_out"
    if echo "$create_out" | grep -qi 'already exists'; then
      echo "D1 database ${DB_NAME} already exists; listing again"
      list_out="$(npx wrangler d1 list --json 2>/dev/null || npx wrangler d1 list 2>&1)"
      echo "$list_out"
      db_id="$(DB_NAME="$DB_NAME" LIST_OUT="$list_out" node --input-type=module -e '
const name = process.env.DB_NAME
const raw = process.env.LIST_OUT ?? ""
let id = ""
try {
  const parsed = JSON.parse(raw)
  const rows = Array.isArray(parsed) ? parsed : []
  for (const row of rows) {
    if (row?.name === name) id = String(row.uuid ?? row.id ?? "")
  }
} catch {
  const match = raw.match(/([0-9a-f-]{36})/)
  if (match) id = match[1]
}
process.stdout.write(id)
')"
    else
      echo '::error::Failed to create D1 database xteink-read-later-candidates. Add Account permission D1: Edit to CLOUDFLARE_API_TOKEN, or create it once with: npx wrangler d1 create xteink-read-later-candidates'
      exit 1
    fi
  else
    echo "$create_out"
    db_id="$(printf '%s' "$create_out" | node --input-type=module -e '
import { readFileSync } from "node:fs"
const raw = readFileSync(0, "utf8")
const match = raw.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)
  ?? raw.match(/"database_id":\s*"([0-9a-f-]{36})"/)
  ?? raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
process.stdout.write(match?.[1] ?? "")
')"
  fi
fi

if [[ -z "$db_id" ]]; then
  echo '::error::Could not determine D1 database id for xteink-read-later-candidates.'
  exit 1
fi

echo "Using D1 database ${DB_NAME} id ${db_id}"

PLACEHOLDER_ID="$PLACEHOLDER_ID" DB_ID="$db_id" CONFIG="$CONFIG" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
const path = process.env.CONFIG
const placeholder = process.env.PLACEHOLDER_ID
const id = process.env.DB_ID
let text = readFileSync(path, "utf8")
if (!text.includes(placeholder) && !text.includes(id)) {
  console.error("wrangler.jsonc is missing the CANDIDATES database_id placeholder.")
  process.exit(1)
}
text = text.replaceAll(placeholder, id)
writeFileSync(path, text)
'

echo "Applying D1 migrations for ${DB_NAME}"
if migrate_out="$(npx wrangler d1 migrations apply "$DB_NAME" --remote 2>&1)"; then
  echo "$migrate_out"
  exit 0
fi

echo "$migrate_out"
echo '::error::Failed to apply D1 migrations. Restore with wrangler d1 time-travel if a partial apply left the schema unexpected. Existing R2 articles are untouched.'
exit 1
