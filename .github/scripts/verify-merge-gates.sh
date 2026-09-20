#!/usr/bin/env bash
# Verify live GitHub merge gates. Do not print tokens.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-marufeuille/xteink-read-later}"
RULESET_NAME='main-merge-gates'
GITHUB_ACTIONS_APP_ID=15368
failed=0

fail() {
  echo "verify failed: $1"
  failed=1
}

ok() {
  echo "ok: $1"
}

json_get() {
  node --input-type=module -e '
import { readFileSync } from "node:fs"
const value = JSON.parse(readFileSync(0, "utf8"))[process.argv[1]]
process.stdout.write(process.argv[2] === "bool" ? (value ? "true" : "false") : String(value ?? ""))
' "$1" "${2:-}"
}

repo_json="$(gh api "repos/${REPO}")"
visibility="$(printf '%s' "$repo_json" | json_get visibility)"
auto_merge="$(printf '%s' "$repo_json" | json_get allow_auto_merge bool)"

if [[ "$visibility" == public ]]; then
  ok "repository is public"
else
  echo "repository visibility is ${visibility}; rulesets need public or GitHub Pro"
fi

if [[ "$auto_merge" != true ]]; then
  fail "allow_auto_merge is not enabled"
else
  ok "auto-merge is enabled"
fi

workflow_perms="$(gh api "repos/${REPO}/actions/permissions/workflow")"
can_approve="$(printf '%s' "$workflow_perms" | json_get can_approve_pull_request_reviews bool)"
default_perms="$(printf '%s' "$workflow_perms" | json_get default_workflow_permissions)"
if [[ "$can_approve" != false ]]; then
  fail "Actions can approve pull request reviews"
else
  ok "Actions cannot approve pull request reviews"
fi
if [[ "$default_perms" != read ]]; then
  fail "default workflow permissions are ${default_perms}, expected read"
else
  ok "default workflow permissions are read"
fi

ruleset_id="$(gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name==\"${RULESET_NAME}\") | .id" | head -n 1 || true)"
if [[ -n "$ruleset_id" ]]; then
  ruleset="$(gh api "repos/${REPO}/rulesets/${ruleset_id}")"
  node --input-type=module -e '
import { readFileSync } from "node:fs"
const rs = JSON.parse(readFileSync(0, "utf8"))
const appId = Number(process.argv[1])
const fail = (message) => {
  console.error(`verify failed: ${message}`)
  process.exitCode = 1
}
const ok = (message) => console.log(`ok: ${message}`)
if (rs.enforcement !== "active") fail(`ruleset enforcement is ${rs.enforcement}`)
else ok("ruleset is active")
if (Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0) {
  fail("ruleset has bypass actors")
} else ok("ruleset has no bypass actors")
const types = new Set((rs.rules ?? []).map((rule) => rule.type))
for (const type of ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]) {
  if (!types.has(type)) fail(`missing ${type} rule`)
  else ok(`has ${type} rule`)
}
const pull = (rs.rules ?? []).find((rule) => rule.type === "pull_request")
if ((pull?.parameters?.required_approving_review_count ?? 1) !== 0) {
  fail("pull requests require human approvals; autonomous merge would stop")
} else ok("pull requests do not require human approvals")
if (pull?.parameters?.required_review_thread_resolution !== true) {
  fail("unresolved review threads are not required")
} else ok("unresolved review threads block merge")
const checks = (rs.rules ?? []).find((rule) => rule.type === "required_status_checks")
const required = checks?.parameters?.required_status_checks ?? []
const mergeGate = required.find((check) => check.context === "merge-gate")
if (!mergeGate) fail("merge-gate is not a required status check")
else ok("merge-gate is required")
if (mergeGate && mergeGate.integration_id !== appId) {
  fail(`merge-gate source is ${mergeGate.integration_id ?? "any"}, expected GitHub Actions ${appId}`)
} else if (mergeGate) ok("merge-gate must come from GitHub Actions")
const hasQueue = types.has("merge_queue")
const strict = checks?.parameters?.strict_required_status_checks_policy === true
if (hasQueue) {
  const queue = (rs.rules ?? []).find((rule) => rule.type === "merge_queue")
  if (queue?.parameters?.grouping_strategy !== "ALLGREEN") {
    fail("merge queue grouping is not ALLGREEN")
  } else ok("merge queue uses ALLGREEN")
  if (strict) fail("up-to-date is required together with merge queue")
  else ok("merge queue replaces up-to-date")
} else if (!strict) {
  fail("neither merge queue nor up-to-date required checks are enabled")
} else ok("required checks must run against latest default branch")
' "$GITHUB_ACTIONS_APP_ID" <<<"$ruleset" || failed=1
else
  echo "ruleset ${RULESET_NAME} not found; checking classic branch protection"
  if ! protection="$(gh api "repos/${REPO}/branches/main/protection" 2>/dev/null)"; then
    fail "no ruleset and no classic branch protection"
  else
    node --input-type=module -e '
import { readFileSync } from "node:fs"
const protection = JSON.parse(readFileSync(0, "utf8"))
const appId = Number(process.argv[1])
const fail = (message) => {
  console.error(`verify failed: ${message}`)
  process.exitCode = 1
}
const ok = (message) => console.log(`ok: ${message}`)
if (protection.enforce_admins?.enabled !== true) fail("admins can bypass classic protection")
else ok("classic protection applies to admins")
if (protection.allow_force_pushes?.enabled === true) fail("force pushes are allowed")
else ok("force pushes are blocked")
if (protection.allow_deletions?.enabled === true) fail("branch deletions are allowed")
else ok("branch deletions are blocked")
if (protection.required_status_checks?.strict !== true) fail("up-to-date is not required")
else ok("required checks must be up to date")
const checks = protection.required_status_checks?.checks ?? []
const mergeGate = checks.find((check) => check.context === "merge-gate")
if (!mergeGate) fail("merge-gate is not a required status check")
else ok("merge-gate is required")
if (mergeGate && mergeGate.app_id !== appId) {
  fail(`merge-gate source is ${mergeGate.app_id ?? "any"}, expected GitHub Actions ${appId}`)
} else if (mergeGate) ok("merge-gate must come from GitHub Actions")
if (!protection.required_pull_request_reviews) fail("pull requests are not required")
else ok("pull requests are required")
' "$GITHUB_ACTIONS_APP_ID" <<<"$protection" || failed=1
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Merge gates match the intended policy"
