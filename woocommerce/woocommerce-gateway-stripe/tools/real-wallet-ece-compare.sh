#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RIG_ID="woocommerce-stripe-ece-product-page"
COMPONENT="woocommerce-gateway-stripe"
BASELINE_REF="${BASELINE_REF:-origin/develop}"
CANDIDATE_REF="${CANDIDATE_REF:-}"
REPEAT="${REPEAT:-5}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
PREVIEW_PORT="${HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT:-}"
PREVIEW_PUBLIC_URL="${HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL:-}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: real-wallet-ece-compare.sh --candidate <ref-or-path> [options]

Canonical Woo Stripe product-page real-wallet ECE compare workflow.

Required preflight:
  --candidate, CANDIDATE_REF             Candidate ref/path to compare
  --preview-port, HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT
  --public-url, HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL
  STRIPE_PUBLISHABLE_KEY
  STRIPE_SECRET_KEY

Options:
  --baseline <ref-or-path>               Default: origin/develop
  --candidate <ref-or-path>              Candidate ref/path
  --repeat <n>                           Default: 5
  --output-dir <dir>                     Default: .homeboy/evidence/woo-stripe-ece-real-wallet-<timestamp>
  --preview-port <port>                  Export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT for this run
  --public-url <https-url>               Export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL for this run
  --dry-run                              Print commands without running Homeboy
  -h, --help                             Show this help

Runs these compare scenarios with --profile real-wallet, --schedule interleaved, and --canonical:
  ece-product-page-waterfall
  ece-product-page-scroll-to-ece
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
    --repeat)
      require_arg "$1" "${2:-}"
      REPEAT="${2:-}"
      shift 2
      ;;
    --output-dir)
      require_arg "$1" "${2:-}"
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --preview-port)
      require_arg "$1" "${2:-}"
      PREVIEW_PORT="${2:-}"
      export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT="$PREVIEW_PORT"
      shift 2
      ;;
    --public-url)
      require_arg "$1" "${2:-}"
      PREVIEW_PUBLIC_URL="${2:-}"
      export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL="$PREVIEW_PUBLIC_URL"
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
[[ "$REPEAT" =~ ^[1-9][0-9]*$ ]] || fail 'repeat must be a positive integer.'
[[ -n "$PREVIEW_PORT" ]] || fail 'preview port is required. Set HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT or pass --preview-port.'
[[ "$PREVIEW_PORT" =~ ^[0-9]+$ ]] || fail 'preview port must be numeric.'
[[ -n "$PREVIEW_PUBLIC_URL" ]] || fail 'public preview URL is required. Set HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL or pass --public-url.'
[[ "$PREVIEW_PUBLIC_URL" =~ ^https:// ]] || fail 'public preview URL must start with https://.'
[[ "$PREVIEW_PUBLIC_URL" != https://localhost* && "$PREVIEW_PUBLIC_URL" != https://127.0.0.1* ]] || fail 'public preview URL must not be localhost.'
[[ -n "${STRIPE_PUBLISHABLE_KEY:-}" ]] || fail 'STRIPE_PUBLISHABLE_KEY is required.'
[[ -n "${STRIPE_SECRET_KEY:-}" ]] || fail 'STRIPE_SECRET_KEY is required.'

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$ROOT_DIR/.homeboy/evidence/woo-stripe-ece-real-wallet-$(date -u +%Y%m%dT%H%M%SZ)"
fi

mkdir -p "$OUTPUT_DIR"

run_compare() {
  local scenario="$1"
  local output="$OUTPUT_DIR/${scenario}.compare.json"
  local log="$OUTPUT_DIR/${scenario}.compare.log"
  local -a command=(
    homeboy trace compare "$COMPONENT" "$scenario"
    --rig "$RIG_ID"
    --baseline-target "$BASELINE_REF"
    --candidate "$CANDIDATE_REF"
    --profile real-wallet
    --repeat "$REPEAT"
    --schedule interleaved
    --canonical
    --output "$output"
  )

  printf '\n== %s ==\n' "$scenario"
  printf 'JSON: %s\n' "$output"
  printf 'Log:  %s\n' "$log"
  printf 'Command:'
  printf ' %q' "${command[@]}"
  printf '\n'

  if [[ "$DRY_RUN" -eq 0 ]]; then
    "${command[@]}" 2>&1 | tee "$log"
  fi
}

cat > "$OUTPUT_DIR/README.md" <<EOF
# Woo Stripe Real-Wallet ECE Compare Evidence

- Baseline: \`$BASELINE_REF\`
- Candidate: \`$CANDIDATE_REF\`
- Profile: \`real-wallet\`
- Repeat: \`$REPEAT\`
- Schedule: \`interleaved\`
- Canonical: \`true\`
- Preview port: \`$PREVIEW_PORT\`
- Public URL: $PREVIEW_PUBLIC_URL

Review \`ece-product-page-waterfall.compare.json\` and \`ece-product-page-scroll-to-ece.compare.json\` together. The command logs live beside each JSON file.
EOF

printf 'Evidence directory: %s\n' "$OUTPUT_DIR"
printf 'Baseline: %s\n' "$BASELINE_REF"
printf 'Candidate: %s\n' "$CANDIDATE_REF"
printf 'Repeat/schedule: %s/interleaved\n' "$REPEAT"
printf 'Preview: localhost:%s -> %s\n' "$PREVIEW_PORT" "$PREVIEW_PUBLIC_URL"

run_compare ece-product-page-waterfall
run_compare ece-product-page-scroll-to-ece

printf '\nEvidence directory: %s\n' "$OUTPUT_DIR"
