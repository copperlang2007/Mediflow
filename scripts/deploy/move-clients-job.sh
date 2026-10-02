#!/usr/bin/env bash
# Run scripts/src/move-clients-between-orgs.ts INSIDE Google Cloud, as a temporary
# Cloud Run Job, because the production database is private-IP only and cannot be
# reached from a laptop. The job reuses the production service's image, service
# account, network and Cloud SQL attachment, and the app's own secrets by
# reference (this script never reads a secret value). It prints the report from
# the job's logs and deletes the job afterwards.
#
#   Dry run (default, read-only, rolls back):
#     scripts/deploy/move-clients-job.sh <from-org-id> <to-org-id>
#   Real move (asks you to type MOVE first):
#     scripts/deploy/move-clients-job.sh <from-org-id> <to-org-id> --apply
#
# Extra flags after the org ids are passed to the script (--allow-hash-only,
# --allow-shared-parent table.column). Needs `gcloud` signed in with access to the
# project. Overrides: GCP_PROJECT_ID, GCP_REGION, GCP_SERVICE.
set -euo pipefail

FROM="${1:?usage: move-clients-job.sh <from-org-id> <to-org-id> [--apply] [flags]}"
TO="${2:?usage: move-clients-job.sh <from-org-id> <to-org-id> [--apply] [flags]}"
shift 2
EXTRA="$*"
APPLY=0
case " ${EXTRA} " in *" --apply "*) APPLY=1 ;; esac

PROJECT="${GCP_PROJECT_ID:-agencyportal-501523}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${GCP_SERVICE:-mediflow-prod}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_TS="${HERE}/../src/move-clients-between-orgs.ts"
[ -f "${SCRIPT_TS}" ] || { echo "Cannot find ${SCRIPT_TS}" >&2; exit 1; }

JOB="move-clients-$(date +%Y%m%d%H%M%S)"
OPERATOR="$(gcloud config get-value account 2>/dev/null || echo unknown)"
ENVFILE="$(mktemp)"
trap 'rm -f "${ENVFILE}"; gcloud run jobs delete "${JOB}" --project "${PROJECT}" --region "${REGION}" --quiet >/dev/null 2>&1 || true' EXIT

describe() { gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format="value($1)"; }
IMAGE="$(describe 'spec.template.spec.containers[0].image')"
SA="$(describe 'spec.template.spec.serviceAccountName')"
SQL="$(describe 'spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"]')"
NI="$(describe 'spec.template.metadata.annotations["run.googleapis.com/network-interfaces"]')"
NETWORK="$(printf '%s' "${NI}" | sed -n 's/.*"network" *: *"\([^"]*\)".*/\1/p')"
SUBNET="$(printf '%s' "${NI}" | sed -n 's/.*"subnetwork" *: *"\([^"]*\)".*/\1/p')"
[ -n "${IMAGE}" ] && [ -n "${SA}" ] && [ -n "${NETWORK}" ] && [ -n "${SUBNET}" ] || {
  echo "Could not read the production service's image/service account/network (got image='${IMAGE}' sa='${SA}' network='${NETWORK}' subnet='${SUBNET}')." >&2
  exit 1
}

if [ "${APPLY}" = 1 ]; then
  echo "This will MOVE clients in PRODUCTION:"
  echo "  from ${FROM}"
  echo "  to   ${TO}"
  read -r -p "Type MOVE to continue: " ANSWER
  [ "${ANSWER}" = "MOVE" ] || { echo "Cancelled."; exit 1; }
fi

SCRIPT_B64="$(gzip -c "${SCRIPT_TS}" | base64 | tr -d '\n')"
cat > "${ENVFILE}" <<EOF
NODE_ENV: "production"
MOVE_ARGS: "--from ${FROM} --to ${TO} --operator ${OPERATOR} ${EXTRA}"
MOVE_SCRIPT_B64: "${SCRIPT_B64}"
EOF

RUN='echo "$MOVE_SCRIPT_B64" | base64 -d | gunzip > /app/scripts/mv-move-clients.ts && cd /app/scripts && node_modules/.bin/tsx mv-move-clients.ts $MOVE_ARGS'

CREATE=(gcloud run jobs create "${JOB}" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE}"
  --service-account "${SA}" --network "${NETWORK}" --subnet "${SUBNET}" --vpc-egress private-ranges-only
  --set-secrets "DATABASE_URL=mediflow-database-url:latest,PHI_ENCRYPTION_KEY=mediflow-phi-encryption-key:latest,PHI_HMAC_KEY=mediflow-phi-hmac-key:latest"
  --env-vars-file "${ENVFILE}" --max-retries 0 --task-timeout 3600s --cpu 1 --memory 1Gi
  --command sh --args "-c,${RUN}")
[ -n "${SQL}" ] && CREATE+=(--set-cloudsql-instances "${SQL}")

echo "Creating temporary job ${JOB} ..."
"${CREATE[@]}"
echo "Running (mode: $([ "${APPLY}" = 1 ] && echo APPLY || echo 'DRY RUN, rolls back')) ..."
STATUS=0
gcloud run jobs execute "${JOB}" --project "${PROJECT}" --region "${REGION}" --wait || STATUS=$?

sleep 10
echo
echo "================ REPORT ================"
gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${JOB}\"" \
  --project "${PROJECT}" --order asc --freshness 2h --format 'value(textPayload)' | sed '/^$/d'
echo "========================================"
echo "Job exit status: ${STATUS} (the temporary job is deleted on exit)."
exit "${STATUS}"
