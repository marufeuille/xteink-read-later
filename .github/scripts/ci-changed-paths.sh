#!/usr/bin/env bash
# Classify a diff into CI jobs (MAR-149).
#
# Skip a job only when every changed path is on that job's allowlist.
# Any other path runs the job. Empty diffs run nothing.
#
# check (typecheck, unit, e2e) skips only:
#   docs/** and *.md outside src/, test/, and simulator/
# simulator images also skips:
#   test/**, vitest.config.ts, vitest.e2e.config.ts, wrangler.*,
#   migrations/**, infra/**, .github/scripts/**, .github/merge-gates/**,
#   .github/workflows/pr-risk.yml, .github/workflows/access-terraform.yml,
#   .dev.vars.example, .gitignore
#   src/**, simulator/**, package.json, package-lock.json,
#   vitest.simulator.config.ts, tsconfig.json, and .github/workflows/ci.yml run it.
# deploy worker also skips docs, tests, simulator, ci.yml, pr-risk.yml,
#   access-terraform.yml, .github/scripts/access-terraform.sh,
#   infra/**, merge-gate/ruleset scripts, and the files above that do not
#   affect the Worker. src/**, package manifests, wrangler.*, tsconfig.json,
#   migrations/**, and .github/scripts/ensure-*.sh run it.
#
# Usage:
#   ci-changed-paths.sh classify < paths.txt
#   ci-changed-paths.sh github
# github reads EVENT_NAME/GITHUB_EVENT_NAME, HEAD_SHA/GITHUB_SHA, and either
# BASE_SHA / BEFORE_SHA or the Actions event payload.
set -euo pipefail

export GIT_TERMINAL_PROMPT=0

check=false
simulator=false
deploy=false
any=false
changed_paths=()

die() {
  echo "::error::$*" >&2
  exit 1
}

is_full_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ || "$1" =~ ^[0-9a-fA-F]{64}$ ]]
}

check_skip_safe() {
  local path="$1"
  case "$path" in
    src/* | test/* | simulator/*) return 1 ;;
  esac
  case "$path" in
    docs/* | *.md) return 0 ;;
  esac
  return 1
}

simulator_skip_safe() {
  local path="$1"
  if check_skip_safe "$path"; then
    return 0
  fi
  case "$path" in
    test/* | migrations/* | infra/* | .github/scripts/* | .github/merge-gates/*) return 0 ;;
    vitest.config.ts | vitest.e2e.config.ts) return 0 ;;
    .github/workflows/pr-risk.yml | .github/workflows/access-terraform.yml) return 0 ;;
    wrangler.json | wrangler.jsonc | wrangler.toml) return 0 ;;
    .dev.vars.example | .gitignore | .editorconfig | .nvmrc | .node-version) return 0 ;;
  esac
  return 1
}

deploy_skip_safe() {
  local path="$1"
  if check_skip_safe "$path"; then
    return 0
  fi
  case "$path" in
    test/* | simulator/* | infra/* | .github/merge-gates/*) return 0 ;;
    vitest.config.ts | vitest.e2e.config.ts | vitest.simulator.config.ts) return 0 ;;
    .github/workflows/pr-risk.yml | .github/workflows/ci.yml | .github/workflows/access-terraform.yml) return 0 ;;
    .github/scripts/ci-changed-paths.sh | .github/scripts/ci-merge-gate.sh) return 0 ;;
    .github/scripts/access-terraform.sh) return 0 ;;
    .github/scripts/apply-merge-gates.sh | .github/scripts/verify-merge-gates.sh) return 0 ;;
    .dev.vars.example | .gitignore | .editorconfig | .nvmrc | .node-version) return 0 ;;
  esac
  return 1
}

note_path() {
  local path="${1-}"
  path="${path#./}"
  [[ -n "$path" ]] || return 0
  changed_paths+=("$path")
  any=true
  if ! check_skip_safe "$path"; then
    check=true
  fi
  if ! simulator_skip_safe "$path"; then
    simulator=true
  fi
  if ! deploy_skip_safe "$path"; then
    deploy=true
  fi
}

reset_flags() {
  check=false
  simulator=false
  deploy=false
  any=false
  changed_paths=()
}

parse_name_status() {
  local file="$1"
  local -a items=()
  local item status i
  while IFS= read -r -d '' item; do
    items+=("$item")
  done <"$file"
  i=0
  while [[ "$i" -lt "${#items[@]}" ]]; do
    status="${items[$i]}"
    i=$((i + 1))
    case "$status" in
      R* | C*)
        note_path "${items[$i]}"
        note_path "${items[$((i + 1))]}"
        i=$((i + 2))
        ;;
      *)
        note_path "${items[$i]}"
        i=$((i + 1))
        ;;
    esac
  done
}

collect_diff_paths() {
  local diff_file
  diff_file="$(mktemp)"
  if [[ "$#" -eq 1 ]]; then
    git diff -z --name-status --find-renames "$1" >"$diff_file"
  else
    git diff -z --name-status --find-renames "$1" "$2" >"$diff_file"
  fi
  parse_name_status "$diff_file"
  rm -f "$diff_file"
}

ensure_commit() {
  local sha="$1"
  is_full_sha "$sha" || die "refusing non-sha revision: ${sha}"
  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    return 0
  fi
  echo "fetching missing commit ${sha}" >&2
  git fetch --no-tags origin "$sha" || true
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    die "commit ${sha} is not available"
  fi
}

event_sha() {
  local event_name="$1"
  local event_path="$2"
  python3 - "$event_name" "$event_path" <<'PY'
import json
import sys

event_name, path = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    event = json.load(handle)
if event_name == "pull_request":
    print(event["pull_request"]["base"]["sha"])
elif event_name == "merge_group":
    print(event["merge_group"]["base_sha"])
elif event_name == "push":
    before = event.get("before") or ""
    print(before)
else:
    sys.exit(2)
PY
}

load_base_sha() {
  local event_name="$1"
  if [[ -n "${BASE_SHA:-}" ]]; then
    return 0
  fi
  local event_path="${GITHUB_EVENT_PATH:-}"
  [[ -n "$event_path" && -f "$event_path" ]] || die "BASE_SHA missing and no event payload"
  BASE_SHA="$(event_sha "$event_name" "$event_path")"
  [[ -n "$BASE_SHA" ]] || die "base sha missing in event payload"
}

load_before_sha() {
  local event_name="$1"
  if [[ -n "${BEFORE_SHA+x}" ]]; then
    return 0
  fi
  local event_path="${GITHUB_EVENT_PATH:-}"
  [[ -n "$event_path" && -f "$event_path" ]] || die "BEFORE_SHA missing and no event payload"
  BEFORE_SHA="$(event_sha "$event_name" "$event_path")"
}

note_tracked_files() {
  local list path
  list="$(git ls-files)"
  while IFS= read -r path; do
    note_path "$path"
  done <<<"$list"
}

finalize() {
  if [[ "$any" == false ]]; then
    check=false
    simulator=false
    deploy=false
  fi
  if [[ "$simulator" == true || "$deploy" == true ]]; then
    check=true
  fi
  echo "changed path count: ${#changed_paths[@]}" >&2
  if [[ "${#changed_paths[@]}" -gt 0 ]]; then
    printf '  %s\n' "${changed_paths[@]}" >&2
  fi
  echo "CI path filter: check=${check} simulator=${simulator} deploy=${deploy}" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo '### CI path filter'
      echo
      echo '| job | run |'
      echo '| --- | --- |'
      echo "| typecheck, unit, e2e | ${check} |"
      echo "| simulator images | ${simulator} |"
      echo "| deploy worker | ${deploy} |"
      echo
      echo 'true のジョブだけ実行する。false は skipped。'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  local line
  line="$(printf 'check=%s\nsimulator=%s\ndeploy=%s' "$check" "$simulator" "$deploy")"
  printf '%s\n' "$line"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$line" >>"$GITHUB_OUTPUT"
  fi
}

classify_stdin() {
  local path
  reset_flags
  while IFS= read -r path || [[ -n "$path" ]]; do
    note_path "$path"
  done
  finalize
}

github_mode() {
  local event_name head_sha
  reset_flags
  event_name="${EVENT_NAME:-${GITHUB_EVENT_NAME:-}}"
  head_sha="${HEAD_SHA:-${GITHUB_SHA:-}}"
  [[ -n "$event_name" ]] || die "event name is missing"
  [[ -n "$head_sha" ]] || die "head sha is missing"
  case "$event_name" in
    pull_request)
      load_base_sha "$event_name"
      ensure_commit "$BASE_SHA"
      ensure_commit "$head_sha"
      collect_diff_paths "${BASE_SHA}...${head_sha}"
      ;;
    merge_group)
      load_base_sha "$event_name"
      ensure_commit "$BASE_SHA"
      ensure_commit "$head_sha"
      collect_diff_paths "$BASE_SHA" "$head_sha"
      ;;
    push)
      load_before_sha "$event_name"
      if [[ -z "$BEFORE_SHA" || "$BEFORE_SHA" =~ ^0+$ ]]; then
        echo "push has no previous commit; classifying every tracked file" >&2
        note_tracked_files
      else
        ensure_commit "$BEFORE_SHA"
        ensure_commit "$head_sha"
        collect_diff_paths "$BEFORE_SHA" "$head_sha"
      fi
      ;;
    *)
      die "unsupported event ${event_name}"
      ;;
  esac
  finalize
}

main() {
  case "${1:-}" in
    classify) classify_stdin ;;
    github) github_mode ;;
    *)
      echo "usage: ci-changed-paths.sh classify | github" >&2
      exit 2
      ;;
  esac
}

main "${1:-}"
