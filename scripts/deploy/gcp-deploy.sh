#!/usr/bin/env bash
# MediFlow → Google Cloud Run PRODUCTION deploy engine.
#
# Run by .github/workflows/deploy-mediflow-gcp.yml AFTER
# scripts/deploy/gcp-bootstrap.sh has been run once (creates the project
# resources, service accounts, and secret placeholders this script fills in
# and deploys against).
#
# Does NOT touch the AI provider or object storage integration — MediFlow
# keeps using AWS Bedrock (BAA-covered) for AI and this script only wires
# Cloud Run's own service account so Application Default Credentials resolve
# for the existing GCS-backed object storage, same code path as today.
#
# Required env (set by the workflow from GitHub Secrets/Variables):
#   GCP_PROJECT_ID, GCP_REGION, GCP_RUN_SA_EMAIL, GCP_CLOUDSQL_CONNECTION,
#   GCP_PHI_BUCKET, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
#   AI_INTEGRATIONS_OPENAI_API_KEY, AI_INTEGRATIONS_OPENAI_BASE_URL
# Optional:
#   AI_INTEGRATIONS_MODEL, APP_ORIGIN, PUBLIC_OBJECT_SEARCH_PATHS,
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
#   TWILIO_WEBHOOK_PUBLIC_HOST, RESEND_API_KEY, EMAIL_FROM_ADDRESS,
#   CONTRACTING_EMAIL_FROM, SENTRY_DSN, ESIGN_SIGNING_CERT_PEM,
#   ESIGN_SIGNING_KEY_PEM, GITHUB_SHA
set -euo pipefail

: "${GCP_PROJECT_ID:?}"
: "${GCP_REGION:?}"
: "${GCP_RUN_SA_EMAIL:?}"
: "${GCP_CLOUDSQL_CONNECTION:?}"
: "${GCP_PHI_BUCKET:?}"
: "${CLERK_SECRET_KEY:?}"
: "${CLERK_PUBLISHABLE_KEY:?}"
: "${AI_INTEGRATIONS_OPENAI_API_KEY:?}"
: "${AI_INTEGRATIONS_OPENAI_BASE_URL:?}"

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
  printf '%s' "$value" | gcloud secrets versions add "$secret_name" --data-file=- --project="${GCP_PROJECT_ID}" >/dev/null
}
log "Syncing credentials to Secret Manager…"
sync_secret mediflow-clerk-secret-key "${CLERK_SECRET_KEY}"
sync_secret mediflow-clerk-publishable-key "${CLERK_PUBLISHABLE_KEY}"
sync_secret mediflow-ai-openai-api-key "${AI_INTEGRATIONS_OPENAI_API_KEY}"
sync_secret mediflow-ai-openai-base-url "${AI_INTEGRATIONS_OPENAI_BASE_URL}"

# Optional secrets: only create/update if the caller actually set them, and
# only reference them in --set-secrets (below) when present, so an unset
# optional credential doesn't fail the deploy on a missing secret.
declare -A OPTIONAL_SECRET_MAP=(
  [TWILIO_ACCOUNT_SID]=mediflow-twilio-account-sid
  [TWILIO_AUTH_TOKEN]=mediflow-twilio-auth-token
  [TWILIO_FROM_NUMBER]=mediflow-twilio-from-number
  [TWILIO_WEBHOOK_PUBLIC_HOST]=mediflow-twilio-webhook-host
  [RESEND_API_KEY]=mediflow-resend-api-key
  [SENTRY_DSN]=mediflow-sentry-dsn
  [ESIGN_SIGNING_CERT_PEM]=mediflow-esign-cert-pem
  [ESIGN_SIGNING_KEY_PEM]=mediflow-esign-key-pem
  [PUBLIC_OBJECT_SEARCH_PATHS]=mediflow-public-object-search-paths
)
OPTIONAL_SECRETS_FLAG=""
for var in "${!OPTIONAL_SECRET_MAP[@]}"; do
  val="${!var:-}"
  [ -n "$val" ] || continue
  secret="${OPTIONAL_SECRET_MAP[$var]}"
  if ! gcloud secrets describe "$secret" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    gcloud secrets create "$secret" --project="${GCP_PROJECT_ID}" --data-file=- <<<"$val" >/dev/null
    gcloud secrets add-iam-policy-binding "$secret" --project="${GCP_PROJECT_ID}" \
      --member="serviceAccount:${GCP_RUN_SA_EMAIL}" --role="roles/secretmanager.secretAccessor" >/dev/null
  else
    sync_secret "$secret" "$val"
  fi
  OPTIONAL_SECRETS_FLAG="${OPTIONAL_SECRETS_FLAG}${var}=${secret}:latest,"
done

REQUIRED_SECRETS_FLAG="DATABASE_URL=mediflow-database-url:latest,\
PHI_ENCRYPTION_KEY=mediflow-phi-encryption-key:latest,\
PHI_HMAC_KEY=mediflow-phi-hmac-key:latest,\
METRICS_TOKEN=mediflow-metrics-token:latest,\
DIALER_WEBHOOK_SECRET=mediflow-dialer-webhook-secret:latest,\
LEAD_QUEUE_WEBHOOK_SECRET=mediflow-lead-queue-webhook-secret:latest,\
CLERK_SECRET_KEY=mediflow-clerk-secret-key:latest,\
CLERK_PUBLISHABLE_KEY=mediflow-clerk-publishable-key:latest,\
AI_INTEGRATIONS_OPENAI_API_KEY=mediflow-ai-openai-api-key:latest,\
AI_INTEGRATIONS_OPENAI_BASE_URL=mediflow-ai-openai-base-url:latest"

STATIC_ENV="NODE_ENV=production,\
AI_INTEGRATIONS_PROVIDER=bedrock,\
AI_INTEGRATIONS_MODEL=${AI_INTEGRATIONS_MODEL:-us.anthropic.claude-sonnet-4-6},\
MFA_REQUIRED=true,\
LOG_LEVEL=${LOG_LEVEL:-info},\
WEB_STATIC_DIR=/app/artifacts/web-app/dist/public,\
PRIVATE_OBJECT_DIR=${GCP_PHI_BUCKET}/private,\
BUILD_SHA=${SHA}"

log "Deploying ${SERVICE} to Cloud Run (${GCP_REGION})…"
gcloud run deploy "${SERVICE}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --image="${IMAGE}" \
  --service-account="${GCP_RUN_SA_EMAIL}" \
  --add-cloudsql-instances="${GCP_CLOUDSQL_CONNECTION}" \
  --allow-unauthenticated \
  --min-instances="${MIN_INSTANCES:-1}" \
  --max-instances="${MAX_INSTANCES:-10}" \
  --set-env-vars="${STATIC_ENV}" \
  --set-secrets="${REQUIRED_SECRETS_FLAG}${OPTIONAL_SECRETS_FLAG:+,${OPTIONAL_SECRETS_FLAG%,}}" \
  --quiet

SERVICE_URL="$(gcloud run services describe "${SERVICE}" --project="${GCP_PROJECT_ID}" --region="${GCP_REGION}" --format='value(status.url)')"
ORIGIN="${APP_ORIGIN:-$SERVICE_URL}"
log "Public origin (ALLOWED_ORIGIN): ${ORIGIN}"

# ALLOWED_ORIGIN needs the service's own URL, which is only known after the
# first deploy — a fast metadata-only update, no rebuild.
gcloud run services update "${SERVICE}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_REGION}" \
  --update-env-vars="ALLOWED_ORIGIN=${ORIGIN}" \
  --quiet

echo ""
echo "✅ MediFlow production deploy is LIVE."
echo "   Service: ${SERVICE}"
echo "   URL:     ${ORIGIN}"
