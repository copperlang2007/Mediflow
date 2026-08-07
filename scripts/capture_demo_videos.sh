#!/bin/bash

# capture_demo_videos.sh
# Runs all journey evidence captures and bundles them into demos
# Usage: EVIDENCE_BASE_URL=https://preview.vercel.app ./scripts/capture_demo_videos.sh
# Or run a specific journey: ./scripts/capture_demo_videos.sh journeys/01-agent-workspace.journey.ts

set -e

BASE_URL="${EVIDENCE_BASE_URL:-http://localhost:5000}"
HEADED="${EVIDENCE_HEADED:-0}"

echo "🎬 IntelBRIDGE Demo Video Capture Suite"
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
    "journeys/01-agent-workspace.journey.ts"
    "journeys/02-team-lead-workspace.journey.ts"
    "journeys/03-manager-pe-command-center.journey.ts"
    "journeys/04-retention-workspace.journey.ts"
    "journeys/05-compliance-audit-log.journey.ts"
    "journeys/06-agency-owner-admin.journey.ts"
    "journeys/07-viewer-read-only.journey.ts"
    "journeys/08-sales-director-pe-analytics.journey.ts"
  )
fi

# Create evidence output directory
EVIDENCE_OUTPUT="./evidence"
mkdir -p "$EVIDENCE_OUTPUT"

# Run each journey
for journey in "${JOURNEYS[@]}"; do
  if [ ! -f "$journey" ]; then
    echo "⚠️  Journey not found: $journey"
    continue
  fi

  echo ""
  echo "🎥 Capturing: $journey"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Set environment variables
  export EVIDENCE_BASE_URL="$BASE_URL"
  export EVIDENCE_HEADED="$HEADED"

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
