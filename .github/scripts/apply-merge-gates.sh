#!/usr/bin/env bash
# Apply the main merge-gate ruleset and repo settings. Do not print tokens.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULESET_FILE="${ROOT}/.github/merge-gates/main-ruleset.json"
REPO="${GITHUB_REPOSITORY:-marufeuille/xteink-read-later}"
RULESET_NAME='main-merge-gates'
MAKE_PUBLIC=0

usage() {
  echo "Usage: bash .github/scripts/apply-merge-gates.sh [--make-public]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --make-public) MAKE_PUBLIC=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

if [[ ! -f "$RULESET_FILE" ]]; then
  echo "Missing ${RULESET_FILE}"
  exit 1
fi

if ! command -v gh >/dev/null; then
  echo 'gh is required'
  exit 1
fi

if ! command -v node >/dev/null; then
  echo 'node is required'
  exit 1
fi

strip_merge_queue() {
  node --input-type=module -e '
import { readFileSync } from "node:fs"
const rs = JSON.parse(readFileSync(process.argv[1], "utf8"))
rs.rules = rs.rules.filter((rule) => rule.type !== "merge_queue")
const checks = rs.rules.find((rule) => rule.type === "required_status_checks")
if (checks?.parameters) {
  checks.parameters.strict_required_status_checks_policy = true
}
process.stdout.write(JSON.stringify(rs))
' "$RULESET_FILE"
}

wait_for_rulesets() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if gh api "repos/${REPO}/rulesets" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

ensure_public() {
  local visibility
  visibility="$(gh api "repos/${REPO}" --jq .visibility)"
  if [[ "$visibility" == public ]]; then
    echo "Repository is public"
    return 0
  fi
  if gh api "repos/${REPO}/rulesets" >/dev/null 2>&1; then
    echo "Repository is ${visibility}; rulesets are already available"
    return 0
  fi
  if [[ "$MAKE_PUBLIC" -ne 1 ]]; then
    echo "Repository visibility is ${visibility}. GitHub Free cannot enforce rulesets or branch protection on a private user-owned repo."
    echo "Will try anyway. If this fails, re-run with --make-public or upgrade to GitHub Pro."
    return 0
  fi
  echo "Making ${REPO} public so merge gates can be enforced on GitHub Free"
  gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences
  if ! wait_for_rulesets; then
    echo 'Rulesets API is still unavailable after changing visibility'
    exit 1
  fi
}

upsert_ruleset() {
  local payload="$1"
  local existing
  existing="$(gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name==\"${RULESET_NAME}\") | .id" | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    echo "Updating ruleset ${RULESET_NAME} (${existing})"
    printf '%s' "$payload" | gh api --method PUT "repos/${REPO}/rulesets/${existing}" --input - --jq '{id,name,enforcement}'
  else
    echo "Creating ruleset ${RULESET_NAME}"
    printf '%s' "$payload" | gh api --method POST "repos/${REPO}/rulesets" --input - --jq '{id,name,enforcement}'
  fi
}

apply_classic_protection() {
  echo 'Falling back to classic branch protection'
  gh api --method PUT "repos/${REPO}/branches/main/protection" --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [],
    "checks": [
      { "context": "merge-gate", "app_id": 15368 }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
}

enable_repo_settings() {
  echo 'Enabling auto-merge and deleting head branches on merge'
  gh api --method PATCH "repos/${REPO}" \
    -F allow_auto_merge=true \
    -F delete_branch_on_merge=true \
    -F allow_update_branch=true >/dev/null
  echo 'Keeping Actions from approving pull requests'
  gh api --method PUT "repos/${REPO}/actions/permissions/workflow" \
    -f default_workflow_permissions=read \
    -F can_approve_pull_request_reviews=false >/dev/null
}

ensure_public

if upsert_ruleset "$(cat "$RULESET_FILE")"; then
  echo 'Applied ruleset with merge queue'
elif upsert_ruleset "$(strip_merge_queue)"; then
  echo 'Merge queue is unavailable. Applied ruleset with required up-to-date checks instead.'
elif apply_classic_protection; then
  echo 'Applied classic branch protection with enforce_admins and up-to-date merge-gate'
else
  echo 'Failed to apply ruleset or classic branch protection.'
  echo 'GitHub Free needs a public repository; re-run with --make-public, or upgrade to GitHub Pro.'
  exit 1
fi

enable_repo_settings
bash "${ROOT}/.github/scripts/verify-merge-gates.sh"
