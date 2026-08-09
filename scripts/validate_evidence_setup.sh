#!/bin/bash

# validate_evidence_setup.sh
# Pre-flight check: are all prerequisites met for demo video capture?

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Demo Video Evidence Setup Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PASS=0
WARN=0
FAIL=0

check_pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASS++))
}

check_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  ((WARN++))
}

check_fail() {
  echo -e "${RED}✗${NC} $1"
  ((FAIL++))
}

# 1. Check Node/npm
echo "📦 Dependencies:"
if command -v node &> /dev/null; then
  NODE_V=$(node --version)
  check_pass "Node installed ($NODE_V)"
else
  check_fail "Node not installed"
fi

if command -v npm &> /dev/null; then
  NPM_V=$(npm --version)
  check_pass "npm installed ($NPM_V)"
else
  check_fail "npm not installed"
fi

# 2. Check Playwright
if [ -d "node_modules/@playwright" ]; then
  check_pass "Playwright installed"
else
  check_warn "Playwright not installed (run: npm install)"
fi

# 3. Check journeys exist
echo ""
echo "📋 Journey Files:"
JOURNEY_COUNT=$(find journeys -name "*.journey.ts" 2>/dev/null | wc -l)
if [ "$JOURNEY_COUNT" -ge 8 ]; then
  check_pass "$JOURNEY_COUNT journey files found"
else
  check_warn "Only $JOURNEY_COUNT journey files (expected 8)"
fi

# 4. Check runner files
echo ""
echo "🎬 Runner Infrastructure:"
[ -f "runner/journey.ts" ] && check_pass "runner/journey.ts exists" || check_fail "runner/journey.ts missing"
[ -f "runner/playwright.evidence.config.ts" ] && check_pass "playwright config exists" || check_fail "playwright config missing"
[ -f "scripts/capture_demo_videos.sh" ] && check_pass "capture script exists" || check_fail "capture script missing"
[ -f "scripts/bundle_evidence.mjs" ] && check_pass "bundle script exists" || check_fail "bundle script missing"

# 5. Check environment
echo ""
echo "🔐 Environment Variables:"
if [ -z "$EVIDENCE_BASE_URL" ]; then
  check_warn "EVIDENCE_BASE_URL not set (default: http://localhost:5000)"
else
  check_pass "EVIDENCE_BASE_URL set to: $EVIDENCE_BASE_URL"
fi

# Check credentials
CRED_COUNT=0
for role in AGENT SUPERVISOR COMPLIANCE_ADMIN COMMISSION LICENSING CRM EXECUTIVE RENEWALS; do
  EMAIL_VAR="TEST_${role}_EMAIL"
  PASS_VAR="TEST_${role}_PASSWORD"
  if [ -n "${!EMAIL_VAR:-}" ] && [ -n "${!PASS_VAR:-}" ]; then
    ((CRED_COUNT++))
  fi
done

if [ "$CRED_COUNT" -eq 8 ]; then
  check_pass "All 8 test accounts configured"
elif [ "$CRED_COUNT" -gt 0 ]; then
  check_warn "$CRED_COUNT test accounts configured (expected 8)"
else
  check_warn "No test accounts configured yet (see .env.evidence.example)"
fi

# 6. Test connectivity (if base URL is set)
echo ""
echo "🌐 Connectivity:"
if [ -n "$EVIDENCE_BASE_URL" ]; then
  if curl -s -o /dev/null -w "%{http_code}" "$EVIDENCE_BASE_URL" > /tmp/http_code.txt; then
    HTTP_CODE=$(cat /tmp/http_code.txt)
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "App is reachable ($HTTP_CODE)"
    elif [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
      check_pass "App is reachable (redirects to login)"
    else
      check_warn "App returned $HTTP_CODE (may be auth gate)"
    fi
  else
    check_fail "App is not reachable"
  fi
else
  check_warn "Skipping app connectivity (EVIDENCE_BASE_URL not set)"
fi

# 7. Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Summary: ${GREEN}${PASS} pass${NC} | ${YELLOW}${WARN} warn${NC} | ${RED}${FAIL} fail${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "✅ Setup is ready!"
  echo ""
  echo "Next steps:"
  echo "  1. Set environment variables (copy from .env.evidence.example):"
  echo "     export EVIDENCE_BASE_URL=https://your-preview.vercel.app"
  echo "     export TEST_AGENT_EMAIL=agent@test.local"
  echo "     export TEST_AGENT_PASSWORD=..."
  echo ""
  echo "  2. Run a single journey:"
  echo "     ./scripts/capture_demo_videos.sh journeys/01-agent-enrollment-aep.journey.ts"
  echo ""
  echo "  3. Or run all journeys in sequence:"
  echo "     ./scripts/capture_demo_videos.sh"
  echo ""
else
  echo "❌ Setup incomplete. Fix the errors above and re-run this check."
  exit 1
fi
