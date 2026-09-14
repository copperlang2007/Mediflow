# MediFlow — Production deploy to Render

This deploys MediFlow to Render in **production** mode (real Clerk auth + PHI
encryption, `NODE_ENV=production`). After a one-time secret setup, every push to
`claude/product-market-launch-selection-iw23qv` deploys automatically — the
workflow provisions the database and injects **every** environment variable for
you, so you never open the Render dashboard to paste config.

> For a throwaway, auth-bypassed demo instead, use `render.yaml` (the demo
> blueprint) — no secrets required. This doc is the real production path.

## What runs

| Piece | Role |
| --- | --- |
| `.github/workflows/deploy-mediflow-render.yml` | Triggers on push / manual dispatch; maps your GitHub Secrets into the deploy engine. |
| `scripts/deploy/render-deploy.mjs` | Provisions Postgres + the web service, computes and pushes the full env, triggers the deploy, waits until it's live. No npm deps. |
| `render.prod.yaml` | Declarative reference blueprint (DB + service + static config). Optional — the engine can create everything via the API. |

## One-time setup

### 1. Get a Render API key
Render dashboard → **Account Settings → API Keys → Create API Key**. Copy it.

### 2. Add GitHub Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**.

**Always required:**

| Secret | Where to get it |
| --- | --- |
| `RENDER_API_KEY` | Step 1 above. |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys. Must be a **live** key (`sk_live_…`). |
| `CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys. Must be **live** (`pk_live_…`). Also baked into the web bundle at build. |
| `AI_INTEGRATIONS_BEDROCK_API_KEY` | Your **Amazon Bedrock API key**. Sent as `x-api-key` by `@anthropic-ai/sdk` against the Bedrock Anthropic Messages endpoint (see `lib/ai/bedrockAnthropicClient.ts`) — it is not an OpenAI credential and never reaches api.openai.com. Bedrock is HIPAA/BAA-covered under your AWS BAA; the server refuses non-BAA providers in prod. |
| `AI_INTEGRATIONS_BEDROCK_BASE_URL` | Bedrock's **Anthropic Messages** endpoint for your region. Either host works with an Amazon Bedrock API key, but **the host and the model id must be changed together** — they use different id forms: `https://bedrock-runtime.us-east-1.amazonaws.com/anthropic` (AWS's recommendation for new applications, and what every deploy path assumes) takes a regional prefix such as `us.anthropic.…` or `global.anthropic.…`, while `https://bedrock-mantle.us-east-1.api.aws/anthropic` is documented with the plain `anthropic.…` form. Since every deploy path injects the runtime-form `us.anthropic.claude-sonnet-4-6`, switching **only** the base URL to mantle leaves a model id that host is not documented to serve; set `AI_INTEGRATIONS_MODEL=anthropic.claude-sonnet-4-6` in the same change. `/admin/health/ai` warns when the two disagree. **Not** `/openai/v1`: AWS lists Chat Completions as unsupported for every Anthropic model, so Claude is unreachable over that path. The legacy `AI_INTEGRATIONS_OPENAI_BASE_URL` name is still read as a fallback so a pre-rename service keeps booting. |
| `AI_INTEGRATIONS_MODEL` | Optional. The Claude model to call. **Both deploy scripts set it explicitly to `us.anthropic.claude-sonnet-4-6`** (`render-deploy.mjs`, `gcp-deploy.sh`), so that — not the code default — is what a scripted deploy actually runs. The code default `claude-sonnet-5` applies only where the variable is genuinely unset. Bedrock model ids carry a provider prefix that differs by endpoint — `global.anthropic.claude-sonnet-5` on `bedrock-runtime`, `anthropic.claude-sonnet-5` on `bedrock-mantle` — so a bare `claude-…` id is prefixed automatically for whichever host the base URL names. Set a fully-prefixed id here to pin a specific routing (e.g. `us.anthropic.claude-sonnet-5` for US-only inference). |
| `PRIVATE_OBJECT_DIR` | GCS bucket/path for private PHI documents (e.g. `mediflow-prod/private`). Hard-required at boot. |

> **AI provider.** The blueprint sets `AI_INTEGRATIONS_PROVIDER=bedrock` and `AI_INTEGRATIONS_MODEL=us.anthropic.claude-sonnet-4-6` (the same Claude Sonnet model IntelBRIDGE uses). To use a different Bedrock model, set the `AI_INTEGRATIONS_MODEL` repository **Variable**. Make sure the model is enabled in your Bedrock account for that region — this is an AWS-side precondition no code change can guard against: Bedrock returns a `not_found`-class error for a model the account has not enabled, and every AI route fails on first use. Check before promoting (`aws bedrock list-foundation-models`, or request model access in the Bedrock console), and confirm `GET /admin/health/ai` returns `ping.ok: true` immediately after deploy. Azure OpenAI also remains supported — set `AI_INTEGRATIONS_PROVIDER=azure` plus the `AI_INTEGRATIONS_AZURE_RESOURCE`/`_DEPLOYMENT` vars instead.

**Optional (a feature simply no-ops until its secret is set):**

| Secret | Enables |
| --- | --- |
| `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`* | Transactional email |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_PUBLIC_HOST` | SMS + inbound SMS webhooks |
| `SENTRY_DSN` | Error tracking (PHI-scrubbed) |
| `ESIGN_SIGNING_CERT_PEM`, `ESIGN_SIGNING_KEY_PEM` | Org-issued PKI signing of completed e-sign PDFs |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Public document search |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` | Subscription billing, checkout, and plan limits |
| `APP_PUBLIC_URL`* | Checkout/portal return URLs (falls back to `ALLOWED_ORIGIN`) |

> **Billing is fail-open when unconfigured, fail-closed when delinquent.** With
> no `STRIPE_SECRET_KEY`, every org resolves to the top tier and no limits are
> enforced — a demo or design-partner install is never crippled by the absence
> of a payment processor. Once Stripe *is* configured, an org with no active
> subscription gets Starter limits, and a canceled one drops back to Starter.
> Point the Stripe webhook endpoint at `POST /webhooks/stripe`; it is
> signature-verified and rejects anything unsigned.

> **E-signature provider.** `ESIGN_PROVIDER` selects between the native
> `mediflow` provider (Beta — no KBA, no managed audit trail) and `docusign`.
> In production the boot guard now refuses `mediflow` unless
> `ESIGN_ALLOW_BETA_IN_PROD=true` is set to accept that risk explicitly.
> DocuSign additionally needs its own integration key, user/account id, RSA
> private key, and base path — `getDocuSignProvider()` names whichever is
> missing.

> **Carrier appointment email.** The email connector now genuinely transmits
> through Resend and throws if it cannot, rather than returning a synthetic id.
> Set `CARRIER_EMAIL_CONNECTOR_DRY_RUN=true` to rehearse the flow without
> sending; dry-run submissions are tagged `dry-run-…` so they can never be
> mistaken for a real carrier submission.

*`EMAIL_FROM_ADDRESS`, `CONTRACTING_EMAIL_FROM`, `AI_INTEGRATIONS_MODEL`,
and naming/region overrides are non-secret — set them as repository **Variables**
(same screen, "Variables" tab) rather than Secrets if you want to override the
defaults.

### 3. (Optional) pin an existing service/DB
If you'd rather create the Render service + Postgres once from `render.prod.yaml`
(New → Blueprint), add their IDs as secrets `RENDER_SERVICE_ID` and
`RENDER_DATABASE_ID`. Otherwise the engine finds them by name
(`mediflow-prod` / `mediflow-prod-db`) or creates them on first run.

## Deploy

- **Automatic:** push to `claude/product-market-launch-selection-iw23qv`.
- **Manual:** Actions tab → *Deploy MediFlow (Render • production)* → **Run workflow**.

The run logs each step and exits non-zero (with the precise missing-secret name)
if anything is misconfigured, so a red ✗ always tells you exactly what to fix.

## What's handled for you

- **Crypto keys generated once, then kept stable.** `PHI_ENCRYPTION_KEY`,
  `PHI_HMAC_KEY`, `METRICS_TOKEN`, `DIALER_WEBHOOK_SECRET`,
  `LEAD_QUEUE_WEBHOOK_SECRET` are generated on the first deploy and reused from
  the service env on every later deploy — **the PHI keys must never rotate** or
  previously-encrypted data can't be decrypted.
- **`DATABASE_URL`** comes from the managed Postgres automatically.
- **`ALLOWED_ORIGIN`** is set to the service's public URL (override with the
  `APP_ORIGIN` variable to use a custom domain).
- **`VITE_CLERK_PUBLISHABLE_KEY`** is mirrored from `CLERK_PUBLISHABLE_KEY` so the
  build-time and runtime keys always match.
- **Migrations** run in Render's pre-deploy step before traffic shifts.

## Known caveat — object storage

MediFlow's object storage targets **Google Cloud Storage**. `PRIVATE_OBJECT_DIR`
selects the bucket/path, but GCS also needs credentials in the runtime
environment (e.g. a `GOOGLE_APPLICATION_CREDENTIALS` JSON, or workload identity).
On Render — which isn't GCP — wire that credential before relying on document
upload/download. The server still boots without it; only the storage feature is
affected. Add the GCS auth mechanism your bucket uses as an additional secret and
extend `OPTIONAL_SECRETS` in `scripts/deploy/render-deploy.mjs` to pass it
through.
