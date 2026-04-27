#!/usr/bin/env bash
# trust-all-packages.sh
#
# Establish GitHub Actions trusted-publisher relationships for every
# @phyxiusjs/* package against this repo's release.yml workflow.
#
# Run once, after the bootstrap publish. Re-runnable safely: if a
# trust is already set, the script logs it and continues. If your
# OTP expires mid-batch (TOTP codes rotate every 30s), the script
# re-prompts and retries the failed package.
#
# Requires:
#   - npm CLI >= 11.10.0 (for `npm trust` subcommand)
#   - You authenticated via `npm login` with publish rights on the
#     @phyxiusjs scope

set -uo pipefail

REPO="rodrigopsasaki/phyxius"
WORKFLOW="release.yml"

PACKAGES=(
  handler connector migration db db-pg
  stats http queue scheduler framework
  resource validate retry circuit-breaker
  strategy state-machine
  clock atom journal process context observe
  handle drain fp temporal config
)

# ── State ──────────────────────────────────────────────────────────

OTP=""
successes=()
already=()
failures=()

# ── Helpers ────────────────────────────────────────────────────────

prompt_otp() {
  echo
  read -srp "OTP (from your authenticator): " OTP
  echo
}

try_trust() {
  local pkg="$1"
  npm trust github "$pkg" \
    --repository="$REPO" \
    --file="$WORKFLOW" \
    --otp="$OTP" \
    -y 2>&1
}

# ── Main ───────────────────────────────────────────────────────────

echo "Establishing trust for ${#PACKAGES[@]} packages."
echo "Repo:     $REPO"
echo "Workflow: $WORKFLOW"
prompt_otp

for name in "${PACKAGES[@]}"; do
  pkg="@phyxiusjs/$name"
  printf "→ %-30s ... " "$pkg"

  output=$(try_trust "$pkg")
  code=$?

  # Re-prompt + retry once on OTP failure (likely an expired code).
  if [ $code -ne 0 ] && echo "$output" | grep -qiE "EOTP|one-time password"; then
    echo "🔁 OTP expired"
    prompt_otp
    printf "  retry %-30s ... " "$pkg"
    output=$(try_trust "$pkg")
    code=$?
  fi

  if [ $code -eq 0 ]; then
    echo "✅"
    successes+=("$name")
  elif echo "$output" | grep -qiE "already|conflict|exists|configured"; then
    echo "✓ already trusted"
    already+=("$name")
  else
    echo "❌"
    echo "$output" | grep -iE "npm (error|warn)" | head -2 | sed 's/^/    /'
    failures+=("$name")
  fi
done

# ── Summary ────────────────────────────────────────────────────────

echo
echo "═══════════════════════════════════════════"
printf "  ✅ Established:  %d\n" "${#successes[@]}"
printf "  ✓  Already set:  %d\n" "${#already[@]}"
printf "  ❌ Failed:       %d\n" "${#failures[@]}"

if [ ${#failures[@]} -gt 0 ]; then
  echo
  echo "Failed packages:"
  for n in "${failures[@]}"; do
    echo "  - @phyxiusjs/$n"
  done
  echo
  echo "Re-run this script with a fresh OTP to retry failures."
  echo "Or inspect manually: npm trust list @phyxiusjs/<name>"
  exit 1
fi

echo
echo "All packages have trust configured."
echo "Verify any one with: npm trust list @phyxiusjs/handler"
