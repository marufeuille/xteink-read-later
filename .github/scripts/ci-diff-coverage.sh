#!/usr/bin/env bash
# Unit diff coverage (MAR-63). Display only: always exits 0.
# merge-gate does not read this job.
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

start=$(date +%s)
npm run test:unit:coverage
vitest_status=$?
end=$(date +%s)
elapsed=$((end - start))
echo "coverage_elapsed_seconds=${elapsed}"
echo "vitest_exit_status=${vitest_status}"

node --experimental-strip-types --disable-warning=ExperimentalWarning src/coverage/cli.ts report \
  --vitest-status "$vitest_status" \
  --elapsed-seconds "$elapsed" \
  || true

exit 0
