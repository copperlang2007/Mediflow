#!/bin/bash

# capture_demo_videos.sh
# Runs all journey evidence captures and bundles them into demos
# Usage: EVIDENCE_BASE_URL=https://preview.vercel.app ./scripts/capture_demo_videos.sh
# Or run a specific journey: ./scripts/capture_demo_videos.sh journeys/01-agent-enrollment-aep.journey.ts

set -e

BASE_URL="${EVIDENCE_BASE_URL:-http://localhost:5000}"
HEADED="${EVIDENCE_HEADED:-0}"

# Auto-detect demo-mode targets when the operator didn't decide explicitly.
# Demo builds swap the auth provider for an always-signed-in shim and render
# no login form, so every journey's authStep times out opaquely unless
# EVIDENCE_ASSUME_SIGNED_IN=1. /api/users/me sits behind requireAuth: an
# unauthenticated 200 means the target resolves a session by itself (demo
# mode); 401 means a real login flow exists. ${VAR+x} keeps an explicit
# operator 0/1 authoritative — only the unset case is probed.
if [ -z "${EVIDENCE_ASSUME_SIGNED_IN+x}" ]; then
  # Require 200 AND a body that actually contains a user object ("id" key):
  # an unauthenticated SPA fallback serves the shell as 200 text/html, and a
  # misconfigured proxy can return 200 + a JSON ERROR body — neither may
  # read as "signed in". (grep, not jq — no extra tool dependency.)
  PROBE_RESP=$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/users/me" || printf '\n000')
  PROBE_STATUS="${PROBE_RESP##*$'\n'}"
  PROBE_BODY="${PROBE_RESP%$'\n'*}"
  if [ "$PROBE_STATUS" = "200" ] && printf '%s' "$PROBE_BODY" | grep -q '"id"'; then
    echo "🔓 Target answers /api/users/me unauthenticated (demo-mode deploy) — skipping login steps (EVIDENCE_ASSUME_SIGNED_IN=1)"
    EVIDENCE_ASSUME_SIGNED_IN=1
  else
    EVIDENCE_ASSUME_SIGNED_IN=0
  fi
fi

echo "🎬 Mediflow Demo Video Capture Suite"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Base URL: $BASE_URL"
echo "Headless: $([ "$HEADED" = "1" ] && echo "NO (headed mode)" || echo "YES")"
echo ""

# If a specific journey is provided
if [ -n "$1" ]; then
  JOURNEYS=("$1")
else
  # Otherwise run all journeys in order
  JOURNEYS=(
    "journeys/01-agent-enrollment-aep.journey.ts"
    "journeys/02-queue-supervisor-wallboard.journey.ts"
    "journeys/03-admin-compliance.journey.ts"
    "journeys/04-commission-specialist.journey.ts"
    "journeys/05-licensing-manager.journey.ts"
    "journeys/06-crm-specialist.journey.ts"
    "journeys/07-fmo-executive-dashboard.journey.ts"
    "journeys/08-renewals-retention-specialist.journey.ts"
  )
fi

# Create evidence output directory
EVIDENCE_OUTPUT="./evidence"
mkdir -p "$EVIDENCE_OUTPUT"

# Run each journey
for journey in "${JOURNEYS[@]}"; do
  if [ ! -f "$journey" ]; then
    echo "❌ Journey not found: $journey" >&2
    exit 1
  fi

  echo ""
  echo "🎥 Capturing: $journey"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Set environment variables
  export EVIDENCE_BASE_URL="$BASE_URL"
  export EVIDENCE_HEADED="$HEADED"
  # Forward the auth-skip flag (resolved above: explicit operator value, or
  # auto-detected from the target's unauthenticated behavior).
  export EVIDENCE_ASSUME_SIGNED_IN="$EVIDENCE_ASSUME_SIGNED_IN"
  export EVIDENCE_DATA_SOURCE="${EVIDENCE_DATA_SOURCE:-synthetic}"

  # Run the journey using Playwright with the evidence config
  npx playwright test \
    --config=runner/playwright.evidence.config.ts \
    "${journey%.ts}.test.ts" \
    || true  # Don't fail the whole suite on one failure

  echo ""
done

echo ""
echo "✅ Demo video capture suite complete"
echo "📁 Evidence location: $EVIDENCE_OUTPUT"
echo "📖 Next steps:"
echo "   1. Review evidence.json in each evidence subdirectory"
echo "   2. Check journey.webm for the recorded video"
echo "   3. Export bundles using bundle_evidence.mjs"
echo ""
