#!/usr/bin/env bash
# Record github.sha and the Worker version id after wrangler deploy.
# The API body can contain email. This script prints only the sha and version id.
set -euo pipefail

sha="${GITHUB_SHA:-unknown}"
sha="$(printf '%s' "$sha" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  sha="unknown"
fi

version="unknown"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  tmp="$(mktemp)"
  status="$(curl -sS --max-time 20 -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/xteink-read-later/deployments" \
    2>/dev/null || printf '000')"
  if [[ "$status" == "200" ]]; then
    parsed="$(node --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e '
      import { readFileSync } from "node:fs"
      import { parseWorkerDeploymentVersion } from "./src/smoke/worker-version.ts"
      const payload = JSON.parse(readFileSync(process.argv[1], "utf8"))
      process.stdout.write(parseWorkerDeploymentVersion(payload))
    ' "$tmp" 2>/dev/null || true)"
    if [[ "$parsed" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      version="$parsed"
    fi
  fi
  rm -f "$tmp"
fi

echo "github.sha=${sha}"
echo "workerVersion=${version}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "github_sha=${sha}"
    echo "worker_version=${version}"
  } >> "$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Deploy revision"
    echo "- github.sha: \`${sha}\`"
    echo "- workerVersion: \`${version}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
