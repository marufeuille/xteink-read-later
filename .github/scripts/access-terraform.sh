#!/usr/bin/env bash
# Access Terraform helpers (MAR-150).
#
# Do not print the environment. Credentials stay in AWS_* and CLOUDFLARE_API_TOKEN.
#
#   access-terraform.sh require-env NAME...
#   access-terraform.sh redact FILE
#   access-terraform.sh comment FILE
#   access-terraform.sh plan-guard FILE
#   access-terraform.sh state-guard FILE
set -euo pipefail

# Policy digest_send_bypass is unchanged. The Bypass application was stored as
# digest_send_bypass; moved.tf renames it to digest_send on apply, not on plan.
stable_addresses=(
  'cloudflare_zero_trust_access_policy.family'
  'cloudflare_zero_trust_access_application.xteink_read_later'
  'cloudflare_zero_trust_access_policy.digest_send_bypass'
)
application_address='cloudflare_zero_trust_access_application.digest_send'
legacy_application_address='cloudflare_zero_trust_access_application.digest_send_bypass'
plan_addresses=(
  "${stable_addresses[@]}"
  "$application_address"
  "$legacy_application_address"
)

marker='<!-- access-terraform-plan -->'
max_plan_chars=50000

die() {
  echo "::error::$*" >&2
  exit 1
}

usage() {
  echo "usage: access-terraform.sh require-env|redact|comment|plan-guard|state-guard ..." >&2
  exit 2
}

require_file() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || die "file not found: ${file:-"(missing)"}"
}

# Replace credential values that are present in the environment, then assignment-shaped leaks.
# Short values are left alone so a placeholder cannot blank unrelated plan text.
redact_stream() {
  local text name value
  text="$(cat)"
  for name in CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
    value="${!name:-}"
    if [[ ${#value} -ge 8 ]]; then
      text="${text//"$value"/[REDACTED]}"
    fi
  done
  printf '%s' "$text" | sed -E \
    -e 's/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|CLOUDFLARE_API_TOKEN|AWS_SESSION_TOKEN)[[:space:]]*=[[:space:]]*[^[:space:]]+/\1=[REDACTED]/g' \
    -e 's/(Authorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g'
}

escape_fences() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//\`\`\`/~~~}"
    printf '%s\n' "$line"
  done
}

require_env() {
  local name
  local -a missing=()
  [[ "$#" -gt 0 ]] || usage
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "::error::Access Terraform credentials are missing: ${missing[*]}. Set GitHub secrets TF_CLOUDFLARE_API_TOKEN, TF_STATE_ACCESS_KEY_ID, and TF_STATE_SECRET_ACCESS_KEY. Workers deploy keeps CLOUDFLARE_API_TOKEN. Values are not printed." >&2
    exit 1
  fi
}

trim_line() {
  local line="$1"
  line="${line#"${line%%[![:space:]]*}"}"
  printf '%s' "$line"
}

plan_guard() {
  local file="$1"
  local line trimmed addr prefix
  local -a hits=()
  require_file "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_line "$line")"
    for addr in "${plan_addresses[@]}"; do
      # Quoted prefix so dots in the address stay literal.
      prefix="# ${addr} "
      if [[ "$trimmed" == "$prefix"* ]]; then
        case "$trimmed" in
          *"will be created"* | *"will be destroyed"* | *"must be replaced"*)
            hits+=("$trimmed")
            ;;
        esac
      fi
    done
  done <"$file"
  if [[ "${#hits[@]}" -gt 0 ]]; then
    echo "::error::Access plan would create, destroy, or replace an imported app or policy. Do not merge or apply. Import or migrate state first." >&2
    printf '%s\n' "${hits[@]}" >&2
    exit 1
  fi
}

state_guard() {
  local file="$1"
  local addr line found
  local -a missing=()
  require_file "$file"
  for addr in "${stable_addresses[@]}"; do
    found=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$addr" ]]; then
        found=true
        break
      fi
    done <"$file"
    if [[ "$found" == false ]]; then
      missing+=("$addr")
    fi
  done
  local has_application=false has_legacy_application=false
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$application_address" ]]; then
      has_application=true
    elif [[ "$line" == "$legacy_application_address" ]]; then
      has_legacy_application=true
    fi
  done <"$file"
  if [[ "$has_application" == true && "$has_legacy_application" == true ]]; then
    echo "::error::Access remote state has both ${application_address} and ${legacy_application_address}. Refusing apply." >&2
    exit 1
  fi
  if [[ "$has_application" == false && "$has_legacy_application" == false ]]; then
    missing+=("$application_address")
  fi
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "::error::Access remote state is missing imported resources. Refusing apply until they are migrated or imported." >&2
    printf '%s\n' "${missing[@]}" >&2
    exit 1
  fi
}

comment() {
  local file="$1"
  local plan note sha run_url
  note=''
  if [[ -z "$file" || ! -f "$file" ]]; then
    plan='(plan output was not captured)'
    note='plan の出力ファイルが無い。ジョブのログを見る。'
  else
    plan="$(redact_stream <"$file" | escape_fences)"
  fi
  if [[ "${#plan}" -gt "$max_plan_chars" ]]; then
    plan="${plan:0:max_plan_chars}"
    note='plan は長いので切った。全文は artifact access-terraform-plan。'
  fi
  printf '%s\n' "$marker"
  printf '%s\n' '## Access Terraform plan'
  printf '%s\n' ''
  sha="${GITHUB_SHA:-}"
  if [[ -n "$sha" ]]; then
    printf '%s\n' "Commit \`${sha}\`"
    printf '%s\n' ''
  fi
  if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
    run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
    printf '%s\n' "Run: ${run_url}"
    printf '%s\n' ''
  fi
  if [[ -n "$note" ]]; then
    printf '%s\n' "$note"
    printf '%s\n' ''
  fi
  cat <<'EOF'
アプリまたはポリシーの create / destroy / replace が出ていたら import 漏れか、意図しない作り直し。その plan はマージしない。has moved to は state のアドレス変更で、アプリの作り直しではない。main の apply は、取り込み済みのリソースが state に無いときは実行しない。Bypass アプリは apply 前は digest_send_bypass、apply 後は digest_send。ポリシーのアドレスは変えない。

EOF
  printf '%s\n' '```'
  printf '%s\n' "$plan"
  printf '%s\n' '```'
}

main() {
  case "${1:-}" in
    require-env)
      shift
      require_env "$@"
      ;;
    redact)
      require_file "${2:-}"
      redact_stream <"$2"
      ;;
    comment) comment "${2:-}" ;;
    plan-guard) plan_guard "${2:-}" ;;
    state-guard) state_guard "${2:-}" ;;
    *) usage ;;
  esac
}

main "$@"
