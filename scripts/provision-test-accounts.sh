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
POOL_DESCRIBE=$(aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" --query 'UserPool.[Name,Arn]' --output text 2>/dev/null || echo '')
# --output text tab-separates the [Name,Arn] pair; pool names may contain
# spaces, so split on the tab — not whitespace — to keep the name intact.
POOL_NAME=''
POOL_ARN=''
IFS=$'\t' read -r POOL_NAME POOL_ARN <<< "$POOL_DESCRIBE" || true

# Layer 1 — resource tags. An Environment=Production/prod tag is an explicit
# operator declaration and outranks any name heuristic: refuse with NO
# override. (list-tags failure degrades to the name check below rather than
# blocking pools that were never tagged.)
if [ -n "$POOL_ARN" ]; then
  ENV_TAG=$(aws cognito-idp list-tags-for-resource --resource-arn "$POOL_ARN" \
    --region "$REGION" --query 'Tags.Environment' --output text 2>/dev/null || echo '')
  ENV_TAG_LOWER="$(printf '%s' "$ENV_TAG" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ENV_TAG_LOWER" == "production" || "$ENV_TAG_LOWER" == "prod" ]]; then
    echo -e "${RED}Refusing: pool '${POOL_NAME}' is tagged Environment=${ENV_TAG}.${NC}"
    echo "This guard has no override — demo credentials must never enter a production pool."
    exit 1
  fi
fi

# Layer 2 — name heuristic (overridable with I_KNOW_THIS_IS_NOT_PROD=1).
# Case-insensitive; the token must START at a word boundary (start or
# [-_.] delimiter) but may run into trailing letters/digits. This admits
# legitimate names like "mediflow_demopool", "DemoUsers", "sandbox2"
# while still rejecting mid-word matches like "protest-workers" and
# "attestation-users".
POOL_NAME_LOWER="$(printf '%s' "$POOL_NAME" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$POOL_NAME_LOWER" =~ (^|[-_.])(demo|preview|test|sandbox|staging) ]] \
   && [[ "${I_KNOW_THIS_IS_NOT_PROD:-0}" != "1" ]]; then
  echo -e "${RED}Refusing to provision demo accounts in pool '${POOL_NAME:-<not found>}'${NC}"
  echo "Pool name does not contain demo/preview/test/sandbox/staging."
  echo "If this really is a non-production pool, re-run with I_KNOW_THIS_IS_NOT_PROD=1."
  exit 1
fi

# Layer 3 — interactive confirmation. When a human is at the keyboard, make
# them type it: these credentials are documented publicly, so planting them is
# never a decision to make on autopilot. Non-TTY (CI) runs rely on layers 1–2;
# I_KNOW_THIS_IS_NOT_PROD=1 skips the prompt for scripted-but-supervised use.
if [ -t 0 ] && [[ "${I_KNOW_THIS_IS_NOT_PROD:-0}" != "1" ]]; then
  echo -e "${YELLOW}About to create demo accounts with a publicly documented password in:${NC}"
  echo "  Pool: ${POOL_NAME:-<unknown>} ($USER_POOL_ID, $REGION)"
  read -r -p "Type 'yes' to continue: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted — nothing was created."
    exit 1
  fi
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

  local create_err="" create_rc=0
  create_err=$(aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --user-attributes Name="email",Value="$email" Name="email_verified",Value="true" \
    --temporary-password "$ACCOUNT_PASSWORD" \
    --message-action SUPPRESS \
    --region "$REGION" 2>&1 >/dev/null) || create_rc=$?

  # Every AWS call below is guarded: under `set -e` a bare failing command
  # (one throttle blip) would abort the whole batch mid-loop, leaving the
  # account set half-provisioned. Failures return 1 instead; the call sites
  # collect them and the script exits nonzero with a summary AFTER attempting
  # every account.
  if [ "$create_rc" -eq 0 ]; then
    if ! aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "$ACCOUNT_PASSWORD" \
      --permanent \
      --region "$REGION"; then
      echo -e "${RED}✗ set-password failed for $email${NC}" >&2
      return 1
    fi
    echo -e "${GREEN}✓${NC}"
    return 0
  fi

  # Only reset the password when the user genuinely already exists — any
  # other failure (throttle, validation, wrong region) must NOT silently
  # rewrite an existing user's credentials.
  if [[ "$create_err" == *UsernameExistsException* ]]; then
    if ! aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$email" \
      --password "$ACCOUNT_PASSWORD" \
      --permanent \
      --region "$REGION"; then
      echo -e "${RED}✗ password reset failed for existing user $email${NC}" >&2
      return 1
    fi
    echo -e "${YELLOW}✓ (exists — password reset)${NC}"
    return 0
  fi

  echo -e "${RED}✗ admin-create-user failed for $email:${NC} $create_err" >&2
  return 1
}

# Accumulates emails whose provisioning failed; reported (with exit 1) after
# the whole batch has been attempted.
FAILED_ACCOUNTS=()

# Mediflow authenticates via Clerk, NOT Cognito (see PROVISION_TEST_ACCOUNTS.md).
# Creating these users in a Cognito pool either pollutes an IntelBRIDGE pool or
# creates accounts the Clerk-backed app can't log into — so the loop is opt-in.
if [[ "${INCLUDE_MEDIFLOW_COGNITO:-0}" == "1" ]]; then
  echo "📋 Mediflow Test Accounts (Cognito — nonstandard, INCLUDE_MEDIFLOW_COGNITO=1):"
  for account in "${MEDIFLOW_ACCOUNTS[@]}"; do
    email="${account%%:*}"
    role="${account##*:}"
    create_user "$email" "$role" "Mediflow" || FAILED_ACCOUNTS+=("$email")
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
  create_user "$email" "$role" "IntelBRIDGE" || FAILED_ACCOUNTS+=("$email")
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "${#FAILED_ACCOUNTS[@]}" -gt 0 ]; then
  echo -e "${RED}✗ Provisioning finished with ${#FAILED_ACCOUNTS[@]} failure(s):${NC}"
  for email in "${FAILED_ACCOUNTS[@]}"; do
    echo "  - $email"
  done
  echo "Re-run the script to retry — creation is idempotent (existing users get a password reset)."
  exit 1
fi
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
