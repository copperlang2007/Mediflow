#!/bin/bash

# provision-test-accounts.sh
# Creates test accounts in AWS Cognito for demo video capture
# Usage: ./scripts/provision-test-accounts.sh <COGNITO_USER_POOL_ID> <TEMP_PASSWORD>

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <COGNITO_USER_POOL_ID> <TEMP_PASSWORD>"
  echo ""
  echo "Example:"
  echo "  $0 us-east-1_abcdef1234 TempPass123!@#"
  echo ""
  echo "Find your COGNITO_USER_POOL_ID in AWS Console > Cognito > User Pools"
  exit 1
fi

USER_POOL_ID="$1"
TEMP_PASSWORD="$2"
REGION="${AWS_REGION:-us-east-1}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

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
    --temporary-password "$TEMP_PASSWORD" \
    --message-action SUPPRESS \
    --region "$REGION" 2>/dev/null; then

    # Set permanent password
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "DemoPass123!SecureEnough" \
      --permanent \
      --region "$REGION" 2>/dev/null

    echo -e "${GREEN}✓${NC}"
    return 0
  else
    # User may already exist, try to set password anyway
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "DemoPass123!SecureEnough" \
      --permanent \
      --region "$REGION" 2>/dev/null || true

    echo -e "${YELLOW}✓ (exists)${NC}"
    return 0
  fi
}

echo "📋 Mediflow Test Accounts:"
for account in "${MEDIFLOW_ACCOUNTS[@]}"; do
  email="${account%%:*}"
  role="${account##*:}"
  create_user "$email" "$role" "Mediflow"
done

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
echo "  Password: DemoPass123!SecureEnough"
echo ""
echo "Next steps:"
echo "  1. Assign roles/groups in AWS Cognito console"
echo "  2. Update .env.evidence in both repos with these credentials"
echo "  3. Run: ./scripts/capture_demo_videos.sh"
echo ""
