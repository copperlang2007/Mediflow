#!/bin/bash

# provision-test-accounts.sh
# Creates test accounts in AWS Cognito for demo video capture
# Usage: ./scripts/provision-test-accounts.sh <COGNITO_USER_POOL_ID> <TEMP_PASSWORD>

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <COGNITO_USER_POOL_ID> <ACCOUNT_PASSWORD>"
  echo ""
  echo "Example:"
  echo "  $0 us-east-1_abcdef1234 'YourStrongPassword123!'"
  echo ""
  echo "Find your COGNITO_USER_POOL_ID in AWS Console > Cognito > User Pools"
  exit 1
fi

USER_POOL_ID="$1"
ACCOUNT_PASSWORD="$2"
REGION="${AWS_REGION:-us-east-1}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Pool-scope guard ─────────────────────────────────────────────────────────
# These accounts use a password that is documented publicly in
# PROVISION_TEST_ACCOUNTS.md. Refuse to plant them in anything that doesn't
# look like a demo/preview/test pool. Fail-closed: if the pool can't be
# described (typo'd ID, missing perms), we refuse too.
POOL_NAME=$(aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" --query 'UserPool.Name' --output text 2>/dev/null || echo '')
# Token must be a full [-_.]-delimited segment: "mediflow-demo" and
# "intelbridge-staging-2" pass; "protest-workers" and "attestation-users"
# (substring inside a word) do not.
if [[ ! "$POOL_NAME" =~ (^|[-_.])(demo|preview|test|sandbox|staging)([-_.]|$) ]] \
   && [[ "${I_KNOW_THIS_IS_NOT_PROD:-0}" != "1" ]]; then
  echo -e "${RED}Refusing to provision demo accounts in pool '${POOL_NAME:-<not found>}'${NC}"
  echo "Pool name does not contain demo/preview/test/sandbox/staging."
  echo "If this really is a non-production pool, re-run with I_KNOW_THIS_IS_NOT_PROD=1."
  exit 1
fi

echo "🔐 Provisioning test accounts for demo video capture"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "User Pool ID: $USER_POOL_ID"
echo "Region: $REGION"
echo ""

# Mediflow accounts (8 roles)
declare -a MEDIFLOW_ACCOUNTS=(
  "agent.demo@mediflow.local:Agent"
  "supervisor.demo@mediflow.local:Supervisor"
  "compliance.demo@mediflow.local:Compliance Admin"
  "commission.demo@mediflow.local:Commission Specialist"
  "licensing.demo@mediflow.local:Licensing Manager"
  "crm.demo@mediflow.local:CRM Specialist"
  "executive.demo@mediflow.local:FMO Executive"
  "renewals.demo@mediflow.local:Renewals Specialist"
)

# IntelBRIDGE accounts (8 roles)
declare -a INTELBRIDGE_ACCOUNTS=(
  "agent.demo@intelbridge.local:Agent"
  "lead.demo@intelbridge.local:Team Lead"
  "manager.demo@intelbridge.local:Sales Manager"
  "director.demo@intelbridge.local:Sales Director"
  "retention.demo@intelbridge.local:Retention Specialist"
  "compliance.demo@intelbridge.local:Compliance Manager"
  "owner.demo@intelbridge.local:Agency Owner"
  "viewer.demo@intelbridge.local:Viewer"
)

create_user() {
  local email="$1"
  local role="$2"
  local product="$3"

  echo -n "Creating $product - $role ($email)... "

  if aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --user-attributes Name="email",Value="$email" Name="email_verified",Value="true" \
    --temporary-password "$ACCOUNT_PASSWORD" \
    --message-action SUPPRESS \
    --region "$REGION" 2>/dev/null; then

    # Set permanent password
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "$ACCOUNT_PASSWORD" \
      --permanent \
      --region "$REGION" 2>/dev/null

    echo -e "${GREEN}✓${NC}"
    return 0
  else
    # User may already exist, try to set password anyway
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "$ACCOUNT_PASSWORD" \
      --permanent \
      --region "$REGION" 2>/dev/null || true

    echo -e "${YELLOW}✓ (exists)${NC}"
    return 0
  fi
}

# Mediflow authenticates via Clerk, NOT Cognito (see PROVISION_TEST_ACCOUNTS.md).
# Creating these users in a Cognito pool either pollutes an IntelBRIDGE pool or
# creates accounts the Clerk-backed app can't log into — so the loop is opt-in.
if [[ "${INCLUDE_MEDIFLOW_COGNITO:-0}" == "1" ]]; then
  echo "📋 Mediflow Test Accounts (Cognito — nonstandard, INCLUDE_MEDIFLOW_COGNITO=1):"
  for account in "${MEDIFLOW_ACCOUNTS[@]}"; do
    email="${account%%:*}"
    role="${account##*:}"
    create_user "$email" "$role" "Mediflow"
  done
else
  echo "📋 Mediflow accounts skipped: Mediflow uses Clerk — create them in the Clerk Dashboard."
  echo "   (Set INCLUDE_MEDIFLOW_COGNITO=1 to force Cognito creation anyway.)"
fi

echo ""
echo "📋 IntelBRIDGE Test Accounts:"
for account in "${INTELBRIDGE_ACCOUNTS[@]}"; do
  email="${account%%:*}"
  role="${account##*:}"
  create_user "$email" "$role" "IntelBRIDGE"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Account provisioning complete!${NC}"
echo ""
echo "Test accounts are ready for demo video capture:"
echo ""
echo "  Email template: {role}.demo@{product}.local"
echo "  Password: the ACCOUNT_PASSWORD you supplied"
echo ""
echo "Next steps:"
echo "  1. Assign roles/groups in AWS Cognito console"
echo "  2. Update .env.evidence in both repos with these credentials"
echo "  3. Run: ./scripts/capture_demo_videos.sh"
echo ""
