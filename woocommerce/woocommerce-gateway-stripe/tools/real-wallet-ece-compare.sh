#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RIG_ID="woocommerce-stripe-ece-product-page"
PROFILE="real-wallet-compare"
BASELINE_REF="${BASELINE_REF:-origin/develop}"
CANDIDATE_REF="${CANDIDATE_REF:-}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: real-wallet-ece-compare.sh --candidate <ref-or-path> [options]

Compatibility wrapper for the Woo Stripe product-page real-wallet ECE compare profile.

Required preflight is declared by the Homeboy trace profile:
  --candidate, CANDIDATE_REF             Candidate ref/path to compare
  STRIPE_PUBLISHABLE_KEY
  STRIPE_SECRET_KEY

Runtime wallet eligibility still requires an HTTPS public preview origin via
HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL or HOMEBOY_PREVIEW_PUBLIC_URL.

Options:
  --baseline <ref-or-path>               Default: origin/develop
  --candidate <ref-or-path>              Candidate ref/path
  --output-dir <dir>                     Default: .homeboy/evidence/woo-stripe-ece-real-wallet-<timestamp>
  --preview-port <port>                  Export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT for this run
  --public-url <https-url>               Export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL for this run
  --dry-run                              Print command without running Homeboy
  -h, --help                             Show this help

Profile defaults: real-wallet-compare, repeat 5, schedule interleaved, canonical.
USAGE
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

require_arg() {
  [[ $# -ge 2 && -n "${2:-}" ]] || fail "$1 requires a value."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline)
      require_arg "$1" "${2:-}"
      BASELINE_REF="${2:-}"
      shift 2
      ;;
    --candidate)
      require_arg "$1" "${2:-}"
      CANDIDATE_REF="${2:-}"
      shift 2
      ;;
    --output-dir)
      require_arg "$1" "${2:-}"
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --preview-port)
      require_arg "$1" "${2:-}"
      export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT="${2:-}"
      shift 2
      ;;
    --public-url)
      require_arg "$1" "${2:-}"
      export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$BASELINE_REF" ]] || fail 'baseline ref/path is required.'
[[ -n "$CANDIDATE_REF" ]] || fail 'candidate ref/path is required. Set CANDIDATE_REF or pass --candidate.'

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$ROOT_DIR/.homeboy/evidence/woo-stripe-ece-real-wallet-$(date -u +%Y%m%dT%H%M%SZ)"
fi

COMMAND=(
  homeboy trace compare-bundle
  --rig "$RIG_ID"
  --profile "$PROFILE"
  --baseline-target "$BASELINE_REF"
  --candidate "$CANDIDATE_REF"
  --output-dir "$OUTPUT_DIR"
)

printf 'Evidence directory: %s\n' "$OUTPUT_DIR"
printf 'Baseline: %s\n' "$BASELINE_REF"
printf 'Candidate: %s\n' "$CANDIDATE_REF"
printf 'Profile: %s\n' "$PROFILE"
printf 'Command:'
printf ' %q' "${COMMAND[@]}"
printf '\n'

if [[ "$DRY_RUN" -eq 0 ]]; then
  "${COMMAND[@]}"
fi

printf '\nEvidence directory: %s\n' "$OUTPUT_DIR"
