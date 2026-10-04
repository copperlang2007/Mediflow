#!/usr/bin/env bash
# agencyBRIDGE → Google Cloud PRODUCTION bootstrap.
#
# One-time, idempotent setup. Run this yourself from a machine (or Cloud
# Shell) authenticated with `gcloud auth login` against an account that can
# create/administer the target project — this repo's Claude session has no
# GCP credentials and cannot run this for you.
#
# What it does:
#   1. Enables the required APIs.
#   2. Creates an Artifact Registry Docker repo.
#   3. Creates a Cloud SQL for PostgreSQL instance + database + user
#      (skipped if it already exists).
#   4. Creates the GCS bucket for PHI documents (PRIVATE_OBJECT_DIR target).
#   5. Creates two service accounts:
#        - mediflow-run-sa    (Cloud Run RUNTIME identity — least privilege:
#          Cloud SQL client, Secret Manager accessor, object admin scoped to
#          the PHI bucket only)
#        - mediflow-deploy-sa (GitHub Actions DEPLOY identity — Cloud Run
#          deployer, Artifact Registry writer, can actAs the runtime SA)
#   6. Sets up Workload Identity Federation so GitHub Actions authenticates
#      as mediflow-deploy-sa with NO long-lived JSON key.
#   7. Generates the PHI/crypto secrets ONCE in Secret Manager and never
#      touches them again if they already exist (rotating PHI_ENCRYPTION_KEY
#      orphans previously-encrypted data — see docs/DEPLOY_GCP_PRODUCTION.md).
#
# Re-running is safe: every step checks for the resource first.
#
# Required env (export before running, or edit the defaults below):
#   PROJECT_ID           GCP project to deploy into (created if it doesn't
#                         exist AND BILLING_ACCOUNT_ID is set).
#   GITHUB_REPO           "owner/repo", e.g. copperlang2007/Mediflow (case-sensitive: WIF compares it exactly)
# Optional env:
#   REGION                Default: us-central1
#   BILLING_ACCOUNT_ID    Only needed if PROJECT_ID doesn't exist yet.
#   DB_TIER               Cloud SQL machine tier. Default: db-custom-2-8192
#   DB_EDITION            Cloud SQL edition. Default: ENTERPRISE. Must be
#                         ENTERPRISE for any db-custom-* tier; ENTERPRISE_PLUS
#                         only accepts db-perf-optimized-N-* tiers.
#   GITHUB_BRANCH         Default: claude/google-cloud-deployment-ml41c2
#   APP_ORIGIN            The web app's address, e.g. https://app.example.com.
#                         When set, the PHI bucket gets a CORS rule so browsers
#                         can PUT call recordings to signed upload URLs.
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to the target GCP project id}"
: "${GITHUB_REPO:?Set GITHUB_REPO to owner/repo, e.g. copperlang2007/Mediflow (case-sensitive: WIF compares it exactly)}"
REGION="${REGION:-us-central1}"
DB_TIER="${DB_TIER:-db-custom-2-8192}"
DB_EDITION="${DB_EDITION:-ENTERPRISE}"
GITHUB_BRANCH="${GITHUB_BRANCH:-claude/google-cloud-deployment-ml41c2}"

NETWORK="${NETWORK:-default}"
SQL_INSTANCE="mediflow-prod-db"
SQL_DB="mediflow_prod"
SQL_USER="mediflow"
BUCKET="${PROJECT_ID}-mediflow-phi"
AR_REPO="mediflow"
RUN_SA="mediflow-run-sa"
DEPLOY_SA="mediflow-deploy-sa"
WIF_POOL="github-pool"
WIF_PROVIDER="github-provider"

log() { echo "▶ $*"; }

log "Project: ${PROJECT_ID}  Region: ${REGION}"

if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  : "${BILLING_ACCOUNT_ID:?Project ${PROJECT_ID} does not exist — set BILLING_ACCOUNT_ID to create it}"
  log "Creating project ${PROJECT_ID}…"
  gcloud projects create "${PROJECT_ID}"
  gcloud billing projects link "${PROJECT_ID}" --billing-account "${BILLING_ACCOUNT_ID}"
fi
gcloud config set project "${PROJECT_ID}" >/dev/null

log "Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  sts.googleapis.com \
  storage.googleapis.com \
  speech.googleapis.com \
  compute.googleapis.com \
  servicenetworking.googleapis.com \
  vpcaccess.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

# ---------------------------------------------------------------------------
# VPC network + Private Service Access.
#
# A private-IP-only Cloud SQL instance lives on a Google-managed VPC peered
# to this one. Cloud Run's --add-cloudsql-instances flag mounts the Cloud
# SQL Auth Proxy's Unix socket, but the proxy's actual data path to a
# private-IP instance still needs a network route — that requires Cloud Run
# to egress onto this VPC (Direct VPC egress, set on the Cloud Run service
# in gcp-deploy.sh), which in turn requires the private-service-access
# peering below to exist before the Cloud SQL instance is created.
# ---------------------------------------------------------------------------
if ! gcloud compute networks describe "${NETWORK}" >/dev/null 2>&1; then
  log "Creating VPC network ${NETWORK}…"
  gcloud compute networks create "${NETWORK}" --subnet-mode=auto
fi
if ! gcloud compute networks subnets describe "${NETWORK}" --region="${REGION}" >/dev/null 2>&1; then
  log "Creating subnet ${NETWORK} in ${REGION} for Direct VPC egress…"
  gcloud compute networks subnets create "${NETWORK}" \
    --network="${NETWORK}" --region="${REGION}" --range=10.8.0.0/28
fi
if ! gcloud compute addresses describe "google-managed-services-${NETWORK}" --global >/dev/null 2>&1; then
  log "Reserving IP range for Private Service Access…"
  gcloud compute addresses create "google-managed-services-${NETWORK}" \
    --global --purpose=VPC_PEERING --prefix-length=16 --network="${NETWORK}"
fi
if ! gcloud services vpc-peerings list --network="${NETWORK}" --format='value(reservedPeeringRanges)' 2>/dev/null \
    | grep -q "google-managed-services-${NETWORK}"; then
  log "Creating Private Service Access peering (required before a private-IP Cloud SQL instance can be created)…"
  gcloud services vpc-peerings connect \
    --service=servicenetworking.googleapis.com \
    --ranges="google-managed-services-${NETWORK}" \
    --network="${NETWORK}"
fi

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------
if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
  log "Creating Artifact Registry repo ${AR_REPO}…"
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker --location="${REGION}" \
    --description="agencyBRIDGE production images"
else
  log "Artifact Registry repo ${AR_REPO} already exists."
fi

# ---------------------------------------------------------------------------
# Cloud SQL for PostgreSQL
# ---------------------------------------------------------------------------
if ! gcloud sql instances describe "${SQL_INSTANCE}" >/dev/null 2>&1; then
  log "Creating Cloud SQL instance ${SQL_INSTANCE} (this takes several minutes)…"
  # --edition is REQUIRED, not cosmetic. Without it the API picks
  # ENTERPRISE_PLUS, which rejects every `db-custom-*` tier:
  #   ERROR: Invalid Tier (db-custom-2-8192) for (ENTERPRISE_PLUS) Edition.
  # ENTERPRISE is the right tier family for this workload — Enterprise Plus
  # buys a data cache and near-zero-downtime maintenance at roughly double
  # the price, neither of which a pre-revenue single-tenant API needs.
  # Override with DB_EDITION=ENTERPRISE_PLUS *and* a db-perf-optimized-N-*
  # DB_TIER if that changes.
  gcloud sql instances create "${SQL_INSTANCE}" \
    --database-version=POSTGRES_16 \
    --edition="${DB_EDITION}" \
    --tier="${DB_TIER}" \
    --region="${REGION}" \
    --storage-auto-increase \
    --backup \
    --network="projects/${PROJECT_ID}/global/networks/${NETWORK}" \
    --no-assign-ip
  # HIPAA baseline: no public IP. Cloud Run reaches it over Direct VPC
  # egress + the Cloud SQL Auth Proxy socket (--add-cloudsql-instances),
  # not a routable address — see gcp-deploy.sh's --network/--subnet/
  # --vpc-egress flags, which must target this same network.
else
  log "Cloud SQL instance ${SQL_INSTANCE} already exists."
fi
SQL_CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --format='value(connectionName)')"

if ! gcloud sql databases describe "${SQL_DB}" --instance="${SQL_INSTANCE}" >/dev/null 2>&1; then
  log "Creating database ${SQL_DB}…"
  gcloud sql databases create "${SQL_DB}" --instance="${SQL_INSTANCE}"
fi

if ! gcloud secrets describe mediflow-db-password >/dev/null 2>&1; then
  log "Generating DB password and creating user ${SQL_USER}…"
  DB_PASSWORD="$(openssl rand -base64 32)"
  printf '%s' "${DB_PASSWORD}" | gcloud secrets create mediflow-db-password --data-file=-
  if gcloud sql users describe "${SQL_USER}" --instance="${SQL_INSTANCE}" >/dev/null 2>&1; then
    gcloud sql users set-password "${SQL_USER}" --instance="${SQL_INSTANCE}" --password="${DB_PASSWORD}"
  else
    gcloud sql users create "${SQL_USER}" --instance="${SQL_INSTANCE}" --password="${DB_PASSWORD}"
  fi
else
  log "mediflow-db-password secret already exists — reusing existing DB credential."
  DB_PASSWORD="$(gcloud secrets versions access latest --secret=mediflow-db-password)"
fi

# DATABASE_URL over the Cloud Run Cloud SQL Unix socket (no public IP, no
# separate proxy sidecar — Cloud Run mounts the socket when
# --add-cloudsql-instances is set on the service).
ENCODED_DB_PASSWORD="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "${DB_PASSWORD}")"
DATABASE_URL="postgresql://${SQL_USER}:${ENCODED_DB_PASSWORD}@localhost/${SQL_DB}?host=/cloudsql/${SQL_CONNECTION_NAME}"
if ! gcloud secrets describe mediflow-database-url >/dev/null 2>&1; then
  printf '%s' "${DATABASE_URL}" | gcloud secrets create mediflow-database-url --data-file=-
else
  printf '%s' "${DATABASE_URL}" | gcloud secrets versions add mediflow-database-url --data-file=-
fi

# ---------------------------------------------------------------------------
# GCS bucket for PHI documents (PRIVATE_OBJECT_DIR)
# ---------------------------------------------------------------------------
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  log "Creating PHI documents bucket gs://${BUCKET}…"
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
else
  log "Bucket gs://${BUCKET} already exists."
fi

# Call recordings upload from the browser straight to the bucket with a signed
# PUT URL (docs/call-scoring.md); without this CORS rule every upload fails.
if [[ -n "${APP_ORIGIN:-}" ]]; then
  if [[ ! "${APP_ORIGIN}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "APP_ORIGIN must look like https://app.example.com (no path)" >&2
    exit 1
  fi
  log "Allowing recording uploads to gs://${BUCKET} from ${APP_ORIGIN}…"
  CORS_FILE="$(mktemp)"
  printf '[{"origin":["%s"],"method":["PUT"],"responseHeader":["Content-Type","x-goog-if-generation-match"],"maxAgeSeconds":3600}]\n' "${APP_ORIGIN}" > "${CORS_FILE}"
  gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}"
  rm -f "${CORS_FILE}"
else
  CORS_ORIGINS="$(gcloud storage buckets describe "gs://${BUCKET}" --format='value(cors_config[].origin)' 2>/dev/null || true)"
  if [[ -z "${CORS_ORIGINS}" || "${CORS_ORIGINS}" == "[]" ]]; then
    echo "WARNING: APP_ORIGIN is not set and gs://${BUCKET} has no CORS rule. Browser uploads of call" >&2
    echo "         recordings will fail until you re-run with APP_ORIGIN=https://your-app-address." >&2
  else
    log "APP_ORIGIN not set: keeping the bucket's existing CORS rule (${CORS_ORIGINS})."
  fi
fi

# ---------------------------------------------------------------------------
# Generated crypto secrets — created ONCE, never rotated by this script.
# ---------------------------------------------------------------------------
for name in mediflow-phi-encryption-key mediflow-phi-hmac-key; do
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    log "Generating ${name} (32 random bytes, base64)…"
    openssl rand -base64 32 | tr -d '\n' | gcloud secrets create "${name}" --data-file=-
  else
    log "${name} already exists — leaving it untouched (PHI keys must never rotate)."
  fi
done
for name in mediflow-metrics-token mediflow-dialer-webhook-secret mediflow-lead-queue-webhook-secret; do
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    log "Generating ${name} (32 random bytes, hex)…"
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "${name}" --data-file=-
  fi
done

# Placeholder secrets for third-party credentials — created empty if absent
# so `gcloud secrets versions add` in CI has something to version. The deploy
# workflow overwrites these from GitHub Secrets on every run. Includes every
# OPTIONAL secret gcp-deploy.sh may reference too: that script only ever
# calls `versions add` (never `secrets create` / `add-iam-policy-binding`),
# so every secret it can touch — required or optional — must already exist
# with the deploy SA's version-add grant in place before CI runs.
# The operator-facing GitHub/app env var for the Bedrock endpoint is
# AI_INTEGRATIONS_BEDROCK_BASE_URL, but the Secret Manager RESOURCE name stays
# mediflow-ai-openai-base-url for backward compatibility with already-
# bootstrapped projects. The rename lives only at the GitHub/app env layer.
REQUIRED_CREDENTIAL_SECRETS="mediflow-clerk-secret-key mediflow-clerk-publishable-key \
mediflow-ai-openai-api-key mediflow-ai-openai-base-url"
OPTIONAL_CREDENTIAL_SECRETS="mediflow-twilio-account-sid mediflow-twilio-auth-token \
mediflow-twilio-from-number mediflow-twilio-webhook-host mediflow-resend-api-key \
mediflow-sentry-dsn mediflow-esign-cert-pem mediflow-esign-key-pem \
mediflow-public-object-search-paths mediflow-enrollhere-webhook-secret \
mediflow-ghl-private-integration-token \
mediflow-twilio-api-key-secret \
mediflow-statement-ingest-google-credentials"
for name in ${REQUIRED_CREDENTIAL_SECRETS} ${OPTIONAL_CREDENTIAL_SECRETS}; do
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    log "Creating placeholder secret ${name} (CI fills the real value in if you use it)…"
    printf 'unset' | gcloud secrets create "${name}" --data-file=-
  fi
done

# ---------------------------------------------------------------------------
# Service accounts
# ---------------------------------------------------------------------------
RUN_SA_EMAIL="${RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "${RUN_SA_EMAIL}" >/dev/null 2>&1; then
  log "Creating runtime service account ${RUN_SA_EMAIL}…"
  gcloud iam service-accounts create "${RUN_SA}" --display-name="agencyBRIDGE Cloud Run runtime"
fi
if ! gcloud iam service-accounts describe "${DEPLOY_SA_EMAIL}" >/dev/null 2>&1; then
  log "Creating deploy service account ${DEPLOY_SA_EMAIL}…"
  gcloud iam service-accounts create "${DEPLOY_SA}" --display-name="agencyBRIDGE GitHub Actions deployer"
fi

log "Granting runtime SA least-privilege roles…"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/cloudsql.client" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null
# Call recordings are transcribed with Speech-to-Text (SPEECH_TO_TEXT_PROVIDER=google).
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/speech.client" >/dev/null
# Speech-to-Text reads the gs:// recording as its own service agent; give it
# read access to the PHI bucket (created on first use of the API, hence the identity call).
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
gcloud beta services identity create --service=speech.googleapis.com --project="${PROJECT_ID}" >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-speech.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer" >/dev/null
for name in mediflow-database-url mediflow-phi-encryption-key mediflow-phi-hmac-key \
            mediflow-metrics-token mediflow-dialer-webhook-secret mediflow-lead-queue-webhook-secret \
            ${REQUIRED_CREDENTIAL_SECRETS} ${OPTIONAL_CREDENTIAL_SECRETS}; do
  gcloud secrets add-iam-policy-binding "${name}" \
    --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/secretmanager.secretAccessor" >/dev/null
done

log "Granting deploy SA CI roles…"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" --role="roles/run.developer" >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" --role="roles/artifactregistry.writer" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "${RUN_SA_EMAIL}" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" --role="roles/iam.serviceAccountUser" >/dev/null
for name in ${REQUIRED_CREDENTIAL_SECRETS} ${OPTIONAL_CREDENTIAL_SECRETS}; do
  gcloud secrets add-iam-policy-binding "${name}" \
    --member="serviceAccount:${DEPLOY_SA_EMAIL}" --role="roles/secretmanager.secretVersionAdder" >/dev/null
done

# ---------------------------------------------------------------------------
# Workload Identity Federation — GitHub Actions auths as DEPLOY_SA with no
# long-lived JSON key.
# ---------------------------------------------------------------------------
if ! gcloud iam workload-identity-pools describe "${WIF_POOL}" --location=global >/dev/null 2>&1; then
  log "Creating Workload Identity Pool ${WIF_POOL}…"
  gcloud iam workload-identity-pools create "${WIF_POOL}" --location=global \
    --display-name="GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
    --location=global --workload-identity-pool="${WIF_POOL}" >/dev/null 2>&1; then
  log "Creating Workload Identity Provider ${WIF_PROVIDER} scoped to ${GITHUB_REPO}…"
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --location=global --workload-identity-pool="${WIF_POOL}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
else
  # Re-runs must repair an existing provider: the condition is case-sensitive,
  # so a provider created with the wrong repo casing would otherwise keep
  # rejecting GitHub Actions even though the IAM binding below is correct.
  log "Updating Workload Identity Provider ${WIF_PROVIDER} condition to ${GITHUB_REPO}…"
  gcloud iam workload-identity-pools providers update-oidc "${WIF_PROVIDER}" \
    --location=global --workload-identity-pool="${WIF_POOL}" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
fi
WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

cat <<EOF

✅ Bootstrap complete.

Add these as GitHub Actions SECRETS on ${GITHUB_REPO}
(Settings → Secrets and variables → Actions):

  GCP_PROJECT_ID              ${PROJECT_ID}
  GCP_REGION                  ${REGION}
  GCP_WIF_PROVIDER             ${WIF_PROVIDER_RESOURCE}
  GCP_DEPLOY_SA_EMAIL         ${DEPLOY_SA_EMAIL}
  GCP_RUN_SA_EMAIL            ${RUN_SA_EMAIL}
  GCP_CLOUDSQL_CONNECTION     ${SQL_CONNECTION_NAME}
  GCP_PHI_BUCKET              ${BUCKET}
  GCP_NETWORK                 ${NETWORK}

Plus the third-party credentials listed in docs/DEPLOY_GCP_PRODUCTION.md
(CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, AI_INTEGRATIONS_BEDROCK_API_KEY,
AI_INTEGRATIONS_BEDROCK_BASE_URL, and any optional ones you use; the legacy
AI_INTEGRATIONS_OPENAI_BASE_URL name is still accepted as a fallback).

Then push to ${GITHUB_BRANCH} or run the
"Deploy agencyBRIDGE (Google Cloud • production)" workflow manually.
EOF
