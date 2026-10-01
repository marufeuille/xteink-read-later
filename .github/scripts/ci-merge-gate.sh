#!/usr/bin/env bash
# merge-gate for path-filtered CI (MAR-149).
#
# classify changes must succeed. check and simulator images may be success
# or skipped. failure, cancelled, and empty results fail the gate.
# Pass results as arguments or as CHANGES_RESULT, CHECK_RESULT, SIMULATOR_RESULT.
set -euo pipefail

changes="${CHANGES_RESULT:-}"
check="${CHECK_RESULT:-}"
simulator="${SIMULATOR_RESULT:-}"
if [[ "$#" -ge 1 ]]; then
  changes="$1"
  check="${2:-}"
  simulator="${3:-}"
fi

echo "changes job result: ${changes}"
echo "check job result: ${check}"
echo "simulator-images job result: ${simulator}"

if [[ "$changes" != success ]]; then
  echo "::error::classify changes must succeed (got ${changes:-empty})" >&2
  exit 1
fi

accept() {
  local name="$1"
  local result="$2"
  case "$result" in
    success | skipped)
      echo "${name} is ${result}"
      ;;
    *)
      echo "::error::${name} must be success or skipped (got ${result:-empty})" >&2
      exit 1
      ;;
  esac
}

accept "check" "$check"
accept "simulator-images" "$simulator"
