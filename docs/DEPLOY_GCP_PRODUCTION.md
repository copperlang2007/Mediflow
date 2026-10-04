# agencyBRIDGE — Production deploy to Google Cloud Run

This deploys agencyBRIDGE to **Cloud Run** in production mode (real Clerk auth +
PHI encryption, `NODE_ENV=production`) on Cloud SQL for PostgreSQL. After a
one-time setup, every push to `claude/google-cloud-deployment-ml41c2` builds
the production image and deploys it — no GCP console clicking, no long-lived
service-account key stored in GitHub.

> For the throwaway, auth-bypassed local demo instead, use
> `docker compose up` (`docker-compose.yml`) — no GCP account required. This
> doc is the real production path. `render.prod.yaml` is a disabled
> reference (Render has no BAA, so it must not be deployed); `railway.json` is
> the pre-existing Railway path.

## Why Cloud Run + Cloud SQL

agencyBRIDGE's object storage (`artifacts/api-server/src/lib/objectStorage.ts`)
already targets **Google Cloud Storage** via Application Default Credentials
— it was written for GCP. On Render, that means shipping a long-lived
`GOOGLE_APPLICATION_CREDENTIALS` JSON key as a secret (the Render doc's
"known caveat"). On Cloud Run, the runtime service account provides ADC for
free — no key to generate, rotate, or leak.

| Piece | Role |
| --- | --- |
| **Cloud Run** (`mediflow-prod`) | Runs `docker/Dockerfile.prod` — same api-server-serves-web-app layout as the other blueprints, `NODE_ENV=production`, no demo seeding. |
| **Cloud SQL for PostgreSQL 16** (`mediflow-prod-db`) | Managed Postgres, no public IP — reached over the private Cloud SQL socket Cloud Run mounts. |
| **Cloud Storage bucket** (`<project>-mediflow-phi`) | `PRIVATE_OBJECT_DIR` target for PHI documents — the same GCS backend the app already expects. |
| **Secret Manager** | Every credential and the generated PHI/crypto keys. Nothing sensitive lives in Cloud Run env vars in plaintext. |
| **Workload Identity Federation** | GitHub Actions authenticates as the deploy service account with a short-lived OIDC token — no JSON key in GitHub Secrets. |
| `.github/workflows/deploy-mediflow-gcp.yml` | Triggers on push / manual dispatch; builds the image, syncs secrets, deploys. |
| `scripts/deploy/gcp-bootstrap.sh` | One-time provisioning (run by a human with `gcloud` access — this repo's Claude session has none). |
| `scripts/deploy/gcp-deploy.sh` | The CI deploy engine the workflow runs on every push. |

**What did not move**: AI stays on **AWS Bedrock** (`AI_INTEGRATIONS_PROVIDER=bedrock`,
covered by your AWS BAA) — Cloud Run calls out to it over the internet exactly
as Render does today. Changing that is a separate decision (e.g. migrating to
Vertex AI's Anthropic models) — out of scope here.

## One-time setup

### 1. Run the bootstrap script

From a machine with the `gcloud` CLI installed and authenticated
(`gcloud auth login`) as an account that can administer the target project
— **not** from this Claude session, which has no GCP credentials:

```bash
export PROJECT_ID=mediflow-prod        # pick a globally-unique project id
# Match the GitHub repository's owner/name casing exactly: WIF checks this claim.
export GITHUB_REPO=copperlang2007/Mediflow
export BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX   # only if PROJECT_ID doesn't exist yet
bash scripts/deploy/gcp-bootstrap.sh
```

It is idempotent — re-run it any time; every step checks for the resource
first. It prints the GitHub *Secrets* to add when it finishes.

### 2. Add GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

**From the bootstrap script's output:**

| Secret | Value |
| --- | --- |
| `GCP_PROJECT_ID` | printed by the script |
| `GCP_REGION` | printed by the script (default `us-central1`) |
| `GCP_WIF_PROVIDER` | printed by the script |
| `GCP_DEPLOY_SA_EMAIL` | printed by the script |
| `GCP_RUN_SA_EMAIL` | printed by the script |
| `GCP_CLOUDSQL_CONNECTION` | printed by the script |
| `GCP_PHI_BUCKET` | printed by the script |
| `GCP_NETWORK` | printed by the script (default `default`) — must match between bootstrap and deploy: Cloud Run egresses onto this VPC (Direct VPC egress) to reach the private-IP Cloud SQL instance peered to it |

**Third-party credentials (same as the Render path):**

| Secret | Where to get it |
| --- | --- |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys. Must be **live** (`sk_live_…`). |
| `CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys. Must be **live** (`pk_live_…`). Baked into the web bundle at image build time. |
| `AI_INTEGRATIONS_BEDROCK_API_KEY` | Your Amazon Bedrock API key. Sent as `x-api-key` by `@anthropic-ai/sdk` against the Bedrock Anthropic Messages endpoint (see `lib/ai/bedrockAnthropicClient.ts`) — not an OpenAI credential. |
| `AI_INTEGRATIONS_BEDROCK_BASE_URL` | Bedrock's **Anthropic Messages** endpoint for your region. Either host works with an Amazon Bedrock API key: `https://bedrock-runtime.us-east-1.amazonaws.com/anthropic` (AWS's recommendation for new applications) or `https://bedrock-mantle.us-east-1.api.aws/anthropic`. **Not** `/openai/v1`: AWS's API-compatibility matrix lists Chat Completions as unsupported for every Anthropic model, so Claude is unreachable over the OpenAI path. The legacy `AI_INTEGRATIONS_OPENAI_BASE_URL` name is still read as a fallback so a pre-rename environment keeps booting. |
| `AI_INTEGRATIONS_MODEL` | Optional. The Claude model to call. Defaults to `us.anthropic.claude-haiku-4-5-20251001-v1:0` (verified live; `claude-sonnet-5` is not enabled on the current AWS account). Bedrock model ids carry a provider prefix that differs by endpoint — `global.anthropic.claude-sonnet-5` on `bedrock-runtime`, `anthropic.claude-sonnet-5` on `bedrock-mantle` — so a bare `claude-…` id is prefixed automatically for whichever host the base URL names. Set a fully-prefixed id here to pin a specific routing (e.g. `us.anthropic.claude-sonnet-5` for US-only inference). |

**Optional (a feature simply no-ops until its secret is set):** `RESEND_API_KEY`,
`EMAIL_FROM_ADDRESS`* , `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_PUBLIC_HOST`, `SENTRY_DSN`,
`ESIGN_SIGNING_CERT_PEM`, `ESIGN_SIGNING_KEY_PEM`, `PUBLIC_OBJECT_SEARCH_PATHS`.

*`EMAIL_FROM_ADDRESS`, `CONTRACTING_EMAIL_FROM`, `AI_INTEGRATIONS_MODEL`,
`APP_ORIGIN`, `MIN_INSTANCES`, `MAX_INSTANCES` are non-secret — set them as
repository **Variables** instead.

## Deploy

- **Automatic:** push to `claude/google-cloud-deployment-ml41c2`.
- **Manual:** Actions tab → *Deploy agencyBRIDGE (Google Cloud • production)* → **Run workflow**.

The run is green-but-skipped (with a notice listing what's missing) until
every required secret above is set — a red ✗ never happens during
incremental setup.

## What's handled for you

- **PHI/crypto keys generated once, then never touched.** `PHI_ENCRYPTION_KEY`,
  `PHI_HMAC_KEY`, `METRICS_TOKEN`, `DIALER_WEBHOOK_SECRET`,
  `LEAD_QUEUE_WEBHOOK_SECRET` are generated by the bootstrap script and read
  from Secret Manager on every deploy — **they must never rotate** or
  previously-encrypted PHI can't be decrypted.
- **`DATABASE_URL`** points at the Cloud SQL instance over its private Unix
  socket (`/cloudsql/<connection-name>`, no public IP).
- **`ALLOWED_ORIGIN`** is set to the Cloud Run service's own URL after the
  first deploy (override with the `APP_ORIGIN` repository variable for a
  custom domain).
- **`VITE_CLERK_PUBLISHABLE_KEY`** is baked into the web bundle from the same
  `CLERK_PUBLISHABLE_KEY` secret used at runtime.
- **Migrations** run at container start under a Postgres advisory lock
  (`lib/db/src/migrate-locked.ts`), so Cloud Run's concurrent cold starts
  race harmlessly instead of double-applying the migration journal.
- **Object storage ADC** — the Cloud Run service account is granted
  `roles/storage.objectAdmin` scoped to the PHI bucket only, so
  `objectStorage.ts`'s `new Storage()` resolves credentials automatically.
  No `GOOGLE_APPLICATION_CREDENTIALS` JSON key anywhere.

## Not built here (explicit scope cut)

- **Custom domain / load balancer / WAF.** The service is reachable at its
  `*.run.app` URL. Point a custom domain at it with `gcloud run domain-mappings`
  or a Cloud Load Balancer + Cloud Armor in front, when you're ready — that's
  a follow-up, not blocking a working deploy.
- **Migrating AI off Bedrock to Vertex AI.** Deliberately out of scope; the
  app's `aiProvider.ts` HIPAA guard only allows `azure`/`bedrock` today, and
  cross-cloud Bedrock calls from Cloud Run work fine over the public internet.
- **Decommissioning Render/Railway.** This path runs independently. Cut over
  DNS/traffic to Cloud Run whenever you're satisfied with it; nothing here
  disables the existing deploys.
- **Multi-region / HA Cloud SQL.** Single-zone `db-custom-2-8192` by default —
  bump to a regional (HA) Cloud SQL tier before this is your only production
  database of record for real patient data at scale.
