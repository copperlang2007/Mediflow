#!/usr/bin/env bash
# agencyBRIDGE → Google Cloud Run PRODUCTION deploy engine.
#
# Run by .github/workflows/deploy-mediflow-gcp.yml AFTER
# scripts/deploy/gcp-bootstrap.sh has been run once (creates the project
# resources, service accounts, and secret placeholders this script fills in
# and deploys against).
#
# Does NOT touch the AI provider or object storage integration — agencyBRIDGE
# keeps using AWS Bedrock (BAA-covered) for AI and this script only wires
# Cloud Run's own service account so Application Default Credentials resolve
# for the existing GCS-backed object storage, same code path as today.
#
# Required env (set by the workflow from GitHub Secrets/Variables):
#   GCP_PROJECT_ID, GCP_REGION, GCP_RUN_SA_EMAIL, GCP_CLOUDSQL_CONNECTION,
#   GCP_PHI_BUCKET, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
#   AI_INTEGRATIONS_BEDROCK_API_KEY, AI_INTEGRATIONS_BEDROCK_BASE_URL
#   (AI_INTEGRATIONS_OPENAI_BASE_URL is still accepted as a legacy fallback)
# Optional:
#   GCP_NETWORK (default: default — must match gcp-bootstrap.sh's NETWORK,
#   since Cloud Run needs Direct VPC egress onto the same network the
#   private-IP Cloud SQL instance peers with), AI_INTEGRATIONS_MODEL,
#   APP_ORIGIN, EMAIL_FROM_ADDRESS, CONTRACTING_EMAIL_FROM,
#   PUBLIC_OBJECT_SEARCH_PATHS, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
#   TWILIO_FROM_NUMBER, TWILIO_WEBHOOK_PUBLIC_HOST, RESEND_API_KEY,
#   SENTRY_DSN, ESIGN_SIGNING_CERT_PEM, ESIGN_SIGNING_KEY_PEM, GITHUB_SHA
#
# Every optional SECRET-backed var below (Twilio/Resend/Sentry/e-sign/public
# object paths) must already exist in Secret Manager with this script's
# service account granted secretVersionAdder — gcp-bootstrap.sh pre-creates
# all of them as placeholders precisely so this script only ever needs to
# call `gcloud secrets versions add`, never `secrets create` /
# `add-iam-policy-binding` (the deploy SA is not granted those).
set -euo pipefail

: "${GCP_PROJECT_ID:?}"
: "${GCP_REGION:?}"
: "${GCP_RUN_SA_EMAIL:?}"
: "${GCP_CLOUDSQL_CONNECTION:?}"
: "${GCP_PHI_BUCKET:?}"
: "${CLERK_SECRET_KEY:?}"
: "${CLERK_PUBLISHABLE_KEY:?}"
# Canonical name first, legacy name as fallback -- same either-name contract
# as the base URL. The value is an AWS Bedrock bearer token in both cases.
if [ -z "$(printf '%s' "${AI_INTEGRATIONS_BEDROCK_API_KEY:-}" | tr -d '[:space:]')" ]; then
  AI_INTEGRATIONS_BEDROCK_API_KEY="${AI_INTEGRATIONS_OPENAI_API_KEY:-}"
fi
: "${AI_INTEGRATIONS_BEDROCK_API_KEY:?Set AI_INTEGRATIONS_BEDROCK_API_KEY (the AWS Bedrock bearer token)}"
# Canonical name is AI_INTEGRATIONS_BEDROCK_BASE_URL; the OPENAI-named
# variable is a legacy fallback. Bedrock is not an OpenAI endpoint: AWS lists
# Chat Completions as unsupported for every Anthropic model, so this holds an
# Anthropic Messages URL (.../anthropic), not .../openai/v1.
#
# Whitespace counts as unset, matching resolveAiBaseUrl()'s .trim(). A bare
# :- test would accept "   ", sync it to Secret Manager, and deploy a service
# whose runtime then treats the value as missing.
if [ -z "$(printf '%s' "${AI_INTEGRATIONS_BEDROCK_BASE_URL:-}" | tr -d '[:space:]')" ]; then
  AI_INTEGRATIONS_BEDROCK_BASE_URL="${AI_INTEGRATIONS_OPENAI_BASE_URL:-}"
fi
if [ -z "$(printf '%s' "${AI_INTEGRATIONS_BEDROCK_BASE_URL}" | tr -d '[:space:]')" ]; then
  echo "FATAL: set AI_INTEGRATIONS_BEDROCK_BASE_URL (or the legacy AI_INTEGRATIONS_OPENAI_BASE_URL)" >&2
  exit 1
fi
GCP_NETWORK="${GCP_NETWORK:-default}"

SERVICE="mediflow-prod"
AR_REPO="mediflow"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${SERVICE}:${SHA}"

log() { echo "▶ $*"; }

log "Building production image ${IMAGE}…"
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
docker build \
  -f docker/Dockerfile.prod \
  --build-arg "VITE_CLERK_PUBLISHABLE_KEY=${CLERK_PUBLISHABLE_KEY}" \
  -t "${IMAGE}" .
docker push "${IMAGE}"

# ---------------------------------------------------------------------------
# Sync rotate-able third-party credentials into Secret Manager. Never touches
# the PHI/crypto secrets created once by gcp-bootstrap.sh.
# ---------------------------------------------------------------------------
sync_secret() {
  local secret_name="$1" value="$2"
  [ -n "$value" ] || return 0
  # The deploy SA holds secretVersionAdder, NOT admin — it can add versions but
  # cannot create a secret. A secret this script writes that gcp-bootstrap.sh
  # never created therefore fails here under `set -e`, mid-deploy, with a bare
  # NOT_FOUND, so diagnose that clearly instead of dying opaquely.
  #
  # Diagnose from the WRITE's own failure rather than a prior `secrets describe`:
  # describe needs secretmanager.secrets.get, which this role is not guaranteed
  # to carry. A probe that returns PERMISSION_DENIED for a secret that exists is
  # indistinguishable here from one that is genuinely absent, so gating on it
  # risks aborting every deploy on a correctly provisioned project. Attempting
  # the write costs nothing extra and cannot produce a false negative.
  local add_err
  if ! add_err="$(printf '%s' "$value" | gcloud secrets versions add "$secret_name" --data-file=- --project="${GCP_PROJECT_ID}" 2>&1 >/dev/null)"; then
    echo "FATAL: could not add a version to Secret Manager secret '${secret_name}' in ${GCP_PROJECT_ID}." >&2
    echo "${add_err}" >&2
    if printf '%s' "$add_err" | grep -qi "NOT_FOUND\|was not found"; then
      echo "       The secret does not exist. Re-run scripts/deploy/gcp-bootstrap.sh — it is" >&2
      echo "       idempotent and will create it and grant this deploy service account access." >&2
    elif printf '%s' "$add_err" | grep -qi "PERMISSION_DENIED\|does not have"; then
      echo "       The deploy service account lacks secretVersionAdder on this secret." >&2
      echo "       Re-run scripts/deploy/gcp-bootstrap.sh to (re)apply the IAM binding." >&2
    fi
    exit 1
  fi
}
log "Syncing credentials to Secret Manager…"
sync_secret mediflow-clerk-secret-key "${CLERK_SECRET_KEY}"
sync_secret mediflow-clerk-publishable-key "${CLERK_PUBLISHABLE_KEY}"
# NOTE: the Secret Manager RESOURCE name stays mediflow-ai-openai-api-key.
# Renaming it would require gcp-bootstrap.sh to create a new secret and grant
# the deploy SA access to it before the next deploy could run -- a forced
# extra operator step for a name nobody types. The operator-facing names (the
# GitHub secret and the app env var) are what carry the rename.
sync_secret mediflow-ai-openai-api-key "${AI_INTEGRATIONS_BEDROCK_API_KEY}"
# NOTE: same compatibility rule for the Bedrock base URL: keep the operator-
# facing GitHub/app env var canonical, but store it in the long-lived Secret
# Manager resource so already-bootstrapped projects keep deploying without a
# one-off IAM/bootstrap repair just for the rename.
sync_secret mediflow-ai-openai-base-url "${AI_INTEGRATIONS_BEDROCK_BASE_URL}"

# Optional secrets: every one of these already exists in Secret Manager
# (created as an "unset" placeholder by gcp-bootstrap.sh, with this script's
# service account already granted secretVersionAdder on it) — so only
# `versions add` is ever needed here, and only reference a var in
# --set-secrets (below) when the caller actually set it, so an unset
# optional credential is left off the Cloud Run revision entirely rather
# than resolving to the literal string "unset".
declare -A OPTIONAL_SECRET_MAP=(
  [TWILIO_ACCOUNT_SID]=mediflow-twilio-account-sid
  [TWILIO_AUTH_TOKEN]=mediflow-twilio-auth-token
  [TWILIO_FROM_NUMBER]=mediflow-twilio-from-number
  [TWILIO_WEBHOOK_PUBLIC_HOST]=mediflow-twilio-webhook-host
  [RESEND_API_KEY]=mediflow-resend-api-key
  [SENTRY_DSN]=mediflow-sentry-dsn
  [PUBLIC_OBJECT_SEARCH_PATHS]=mediflow-public-object-search-paths
  [ENROLLHERE_WEBHOOK_SECRET]=mediflow-enrollhere-webhook-secret
  [GHL_PRIVATE_INTEGRATION_TOKEN]=mediflow-ghl-private-integration-token
)
sync_secret mediflow-esign-cert-pem "${ESIGN_SIGNING_CERT_PEM:-}"
sync_secret mediflow-esign-key-pem "${ESIGN_SIGNING_KEY_PEM:-}"
OPTIONAL_SECRETS_FLAG=""
for var in "${!OPTIONAL_SECRET_MAP[@]}"; do
  val="${!var:-}"
  [ -n "$val" ] || continue
  secret="${OPTIONAL_SECRET_MAP[$var]}"
  sync_secret "$secret" "$val"
  OPTIONAL_SECRETS_FLAG="${OPTIONAL_SECRETS_FLAG}${var}=${secret}:latest,"
done

# Optional PLAIN (non-secret) env vars — same "only if set" rule, appended
# directly to Cloud Run's env rather than Secret Manager.
OPTIONAL_ENV_FLAG=""
[ -n "${EMAIL_FROM_ADDRESS:-}" ] && OPTIONAL_ENV_FLAG="${OPTIONAL_ENV_FLAG}EMAIL_FROM_ADDRESS=${EMAIL_FROM_ADDRESS},"
[ -n "${CONTRACTING_EMAIL_FROM:-}" ] && OPTIONAL_ENV_FLAG="${OPTIONAL_ENV_FLAG}CONTRACTING_EMAIL_FROM=${CONTRACTING_EMAIL_FROM},"
# GoHighLevel feed: which org(s) to sync and the GHL sub-account. Not secret —
# the token itself goes through Secret Manager above. Comma-separated org ids
# are joined with ";" here because "," separates --set-env-vars entries.
[ -n "${GHL_SYNC_ORG_IDS:-}" ] && OPTIONAL_ENV_FLAG="${OPTIONAL_ENV_FLAG}GHL_SYNC_ORG_IDS=${GHL_SYNC_ORG_IDS//,/;},"
[ -n "${GHL_LOCATION_ID:-}" ] && OPTIONAL_ENV_FLAG="${OPTIONAL_ENV_FLAG}GHL_LOCATION_ID=${GHL_LOCATION_ID},"
# "," separates --set-env-vars entries; a value containing one would split into
# malformed entries. Fail loudly instead of deploying a garbled environment.
for v in EMAIL_FROM_ADDRESS CONTRACTING_EMAIL_FROM GHL_LOCATION_ID; do
  case "${!v:-}" in *,*) echo "FATAL: ${v} must not contain a comma" >&2; exit 1 ;; esac
done

REQUIRED_SECRETS_FLAG="DATABASE_URL=mediflow-database-url:latest,\
PHI_ENCRYPTION_KEY=mediflow-phi-encryption-key:latest,\
PHI_HMAC_KEY=mediflow-phi-hmac-key:latest,\
METRICS_TOKEN=mediflow-metrics-token:latest,\
DIALER_WEBHOOK_SECRET=mediflow-dialer-webhook-secret:latest,\
LEAD_QUEUE_WEBHOOK_SECRET=mediflow-lead-queue-webhook-secret:latest,\
CLERK_SECRET_KEY=mediflow-clerk-secret-key:latest,\
CLERK_PUBLISHABLE_KEY=mediflow-clerk-publishable-key:latest,\
ESIGN_SIGNING_CERT_PEM=mediflow-esign-cert-pem:latest,\
ESIGN_SIGNING_KEY_PEM=mediflow-esign-key-pem:latest,\
AI_INTEGRATIONS_BEDROCK_API_KEY=mediflow-ai-openai-api-key:latest,\
AI_INTEGRATIONS_BEDROCK_BASE_URL=mediflow-ai-openai-base-url:latest"

STATIC_ENV="NODE_ENV=production,\
AI_INTEGRATIONS_PROVIDER=bedrock,\
ESIGN_PROVIDER=docusign,\
AI_INTEGRATIONS_MODEL=${AI_INTEGRATIONS_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0},\
MFA_REQUIRED=true,\
LOG_LEVEL=${LOG_LEVEL:-info},\
WEB_STATIC_DIR=/app/artifacts/web-app/dist/public,\
PRIVATE_OBJECT_DIR=${GCP_PHI_BUCKET}/private,\
BUILD_SHA=${SHA}${OPTIONAL_ENV_FLAG:+,${OPTIONAL_ENV_FLAG%,}}"

log "Deploying ${SERVICE} to Cloud Run (${GCP_REGION})…"
gcloud run deploy "${SERVICE}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${IMAGE}" \
  --service-account="${GCP_RUN_SA_EMAIL}" \
  --add-cloudsql-instances="${GCP_CLOUDSQL_CONNECTION}" \
  --network="${GCP_NETWORK}" \
  --subnet="${GCP_NETWORK}" \
  --vpc-egress=private-ranges-only \
  --no-invoker-iam-check \
  --memory=2Gi \
  --cpu=2 \
  --min-instances="${MIN_INSTANCES:-1}" \
  --max-instances="${MAX_INSTANCES:-10}" \
  --set-env-vars="${STATIC_ENV}" \
  --set-secrets="${REQUIRED_SECRETS_FLAG}${OPTIONAL_SECRETS_FLAG:+,${OPTIONAL_SECRETS_FLAG%,}}" \
  --quiet

SERVICE_URL="$(gcloud run services describe "${SERVICE}" --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format='value(status.url)')"
PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"
LEGACY_SERVICE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${GCP_REGION}.run.app"
ORIGIN="${APP_ORIGIN:-$SERVICE_URL}"
log "Public origins (ALLOWED_ORIGIN): ${ORIGIN} | ${SERVICE_URL} | ${LEGACY_SERVICE_URL}"

# Both CORS and invitation links need the public URL, which is only known
# after the first deploy. Keep them in the same metadata-only update.
gcloud run services update "${SERVICE}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --update-env-vars="ALLOWED_ORIGIN=${ORIGIN}|${SERVICE_URL}|${LEGACY_SERVICE_URL},APP_BASE_URL=${ORIGIN}" \
  --quiet

echo ""
echo "✅ agencyBRIDGE production deploy is LIVE."
echo "   Service: ${SERVICE}"
echo "   URL:     ${ORIGIN}"
