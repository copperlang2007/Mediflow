# Integration runbook — complete the GHL ⇄ Atlas ⇄ MediFlow inbound routing

A self-contained, autonomous-executor-friendly checklist to finish wiring the
inbound lead queue end to end. Each step has an explicit command and a pass/fail
gate. Steps that must happen in a dashboard are marked **[MANUAL]** with a CLI
alternative where one exists.

Background: `docs/inbound-lead-queue.md` (the queue + signature contract) and
`scripts/src/sign-lead-queue-request.ts` (`pnpm lq:sign`, the reference signer).

## 0. Fill these variables first

```bash
# --- EDIT THESE ---
export MEDIFLOW_API_BASE="https://<your-mediflow-api-host>"   # deployed MediFlow API base URL
export ORG_ID="<agency_org_id>"                                # MediFlow organization id
export TEST_CARRIER_NAME="Acme Health"                         # a carrier that exists for ORG_ID
export TEST_STATE="FL"                                         # a 2-letter state with a ready-to-sell agent
export MEDIFLOW_REPO="$HOME/Mediflow"                          # local clone of copperlang2007/mediflow
export ATLAS_REPO="$HOME/atlas-call-routing"                   # local clone of copperlang2007/atlas-call-routing
export MEDIFLOW_API_DIR="$MEDIFLOW_REPO/artifacts/api-server"  # Vercel-linked API project dir (only used for the Vercel CLI path in Phase 2)
# Per-tenant env var name MediFlow expects (orgId upper-cased, non-alphanumerics -> _):
export SECRET_ENV_NAME="LEAD_QUEUE_WEBHOOK_SECRET_$(printf '%s' "$ORG_ID" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
```

> MediFlow resolves the secret as `LEAD_QUEUE_WEBHOOK_SECRET_<ORGID>` first, then
> falls back to the global `LEAD_QUEUE_WEBHOOK_SECRET`. The per-org name is
> preferred. For a single global secret, set `SECRET_ENV_NAME=LEAD_QUEUE_WEBHOOK_SECRET`.

### 0b. Prerequisites

```bash
node --version            # >= 18
pnpm --version            # repo uses pnpm 10.x
cd "$MEDIFLOW_REPO" && git pull --ff-only origin main
ls scripts/src/sign-lead-queue-request.ts   # must exist
```

Access needed: deploy-platform credentials for **both** the MediFlow API and the
Atlas proxy (to set env vars), and edit access to the GoHighLevel workflow.
**Stop and ask the human** if any are missing.

## Phase 1 — Generate the shared secret (once)

```bash
export LQ_SECRET="$(openssl rand -hex 32)"
# SECURITY: do NOT echo $LQ_SECRET in a shared terminal or CI — it lands in
# shell history and logs. Write it straight into your secret manager / the
# platform env vars in Phase 2. To confirm length without revealing it:
printf '%s' "$LQ_SECRET" | wc -c   # expect 64
# If you must view it once, do so on a trusted machine, then clear the line:
#   history -d "$(history 1 | awk '{print $1}')"   # bash
```

Gate: `LQ_SECRET` is 64 hex chars. Both sides must use this exact value.

## Phase 2 — Provision the secret on BOTH deployments

The same `LQ_SECRET` goes on the MediFlow API (as `$SECRET_ENV_NAME`) and on the
Atlas proxy (whatever var the proxy reads — confirm in Phase 5).

MediFlow API — pick the platform it is deployed on:

- **[MANUAL] Render:** Dashboard → MediFlow API service → Environment → add
  `Key=$SECRET_ENV_NAME`, `Value=$LQ_SECRET` → Save (triggers redeploy).
- **Vercel CLI:**
  ```bash
  cd "$MEDIFLOW_API_DIR"   # the Vercel-linked api project dir
  printf '%s' "$LQ_SECRET" | vercel env add "$SECRET_ENV_NAME" production
  printf '%s' "$LQ_SECRET" | vercel env add "$SECRET_ENV_NAME" preview
  ```

Gate: redeploy completes and the var is present in the running environment.

## Phase 3 — Fix the misconfigured `mediflow-api-server` Vercel project

The `api-server` is a long-running process (in-process pg-boss crons + SSE) and
should run on a process host (Railway / Render / Fly), **not** Vercel serverless
— see `docs/DEPLOY_API_RAILWAY.md` for the turnkey Railway path (the repo ships
`railway.json`). The `mediflow-api-server` Vercel project currently has
`rootDirectory: null` and fails on every PR. Choose one:

- **[MANUAL] If it should deploy the API:** Vercel → project `mediflow-api-server`
  → Settings → General → Root Directory = `artifacts/api-server`; add a Node
  serverless/output config (an Express esbuild bundle won't deploy as a static
  build). Redeploy.
- **[MANUAL] If it was added by mistake (recommended if the API lives on Render):**
  Vercel → project `mediflow-api-server` → Settings → Git → Disconnect (or set
  Ignored Build Step to `exit 0`) so it stops posting red checks.

Gate: a new commit no longer produces a failed `Vercel – mediflow-api-server` check.

## Phase 4 — Verify the MediFlow contract end (no Atlas needed yet)

```bash
cd "$MEDIFLOW_REPO"
LEAD_QUEUE_WEBHOOK_SECRET="$LQ_SECRET" \
pnpm --filter @workspace/scripts lq:sign -- \
  --org "$ORG_ID" --carrier-name "$TEST_CARRIER_NAME" --state "$TEST_STATE" \
  --url "$MEDIFLOW_API_BASE/api/queue/v1/route-inbound" --send
```

Gates:

- `HTTP 200` + `"status":"routed"` + non-null `target_phone` → success.
- `HTTP 200` + `"status":"no_agent_available"` → endpoint + auth OK, but no
  ready-to-sell + available agent for that carrier×state (activate/seed a test
  agent, or pass `--available-only false` to ignore presence).
- `HTTP 401/403` → secret mismatch or clock skew. Re-check Phase 2 (identical
  secret on both sides) and server time within ±5 min.

## Phase 5 — Align & verify the Atlas proxy (needs `atlas-call-routing`)

The proxy must, for each inbound:

1. Build the JSON body `{orgId, carrierId|carrierName, contactState|contactId, ...}`.
2. Compute `t = floor(now/1000)` and
   `v1 = HMAC_SHA256(LQ_SECRET, ${t}.${rawBody})` over the **exact bytes it
   transmits**.
3. Send `X-MB-Signature: t=<t>,v1=<v1>` and `Content-Type: application/json`.
4. POST to `$MEDIFLOW_API_BASE/api/queue/v1/route-inbound` and return
   `target_phone` / `target_user_id` to GHL.

Parity check (must match byte-for-byte):

```bash
# (a) Capture the EXACT body bytes + t the proxy emits for one request
#     (add a debug log in the proxy, or replay from its logs):
export ATLAS_T=<unix_seconds_from_proxy>
export ATLAS_BODY='<exact raw JSON string the proxy sent>'
export ATLAS_V1=<v1 the proxy computed>

# (b) Compute the reference signature for the same (t, body):
cd "$MEDIFLOW_REPO"
LEAD_QUEUE_WEBHOOK_SECRET="$LQ_SECRET" \
pnpm --filter @workspace/scripts lq:sign -- \
  --org "$ORG_ID" --t "$ATLAS_T" --body "$ATLAS_BODY"
# Compare the printed v1 to $ATLAS_V1.
```

Gate: the two `v1` values are identical. If they differ, the proxy is signing
different bytes than it sends — almost always a re-serialized body (key order /
whitespace) or signing a parsed object instead of the raw string. Fix the proxy
to sign the exact transmitted bytes and re-run. Also confirm the proxy reads the
secret from the same value as `LQ_SECRET` and points at `$MEDIFLOW_API_BASE`
(not the old hard-coded stub). Commit + deploy the proxy.

## Phase 6 — GoHighLevel wiring **[MANUAL — browser]**

In the GHL workflow that handles inbound leads, replace the old Atlas HTTP step:

1. **HTTP Request** → `POST https://<atlas-proxy-host>/route` (or, to bypass
   Atlas, directly `POST $MEDIFLOW_API_BASE/api/queue/v1/route-inbound` if GHL
   itself signs) with body
   `{"orgId":"$ORG_ID","contactState":"{{contact.state}}","carrierName":"<carrier>"}`.
2. **Connect Call (IVR)** → Dynamic Number = `{{http_response.target_phone}}`.
3. Branch on `{{http_response.status}} == "no_agent_available"` →
   voicemail / callback / overflow.

## Phase 7 — End-to-end live test + acceptance

1. Mark a test agent **Available** (MediFlow web app sidebar toggle) who is
   ready-to-sell for `$TEST_CARRIER_NAME` in `$TEST_STATE`.
2. Trigger the GHL workflow with a test contact in that state.
3. Confirm the call connects to that agent.
4. In MediFlow, open **/admin/queue** (Live Queue) and confirm a new **routed**
   decision row for that carrier×state/agent.
5. Re-fire the same contact within ~60s → confirm it routes to the **same**
   agent (idempotency) and does not double-book.

Acceptance: live call routed to a ready-to-sell + available agent, decision
visible in Live Queue, retry is idempotent.

## Rollback

- Revert the GHL HTTP step to its previous target.
- Unset `$SECRET_ENV_NAME` on the MediFlow API to fail closed (rejects all proxy
  calls) if you need to halt routing.

## Stop-and-ask conditions (do not guess)

- Missing deploy/secret credentials for either side, or no edit access to the GHL
  workflow.
- Parity `v1` mismatch persists after aligning the proxy body (escalate the exact
  `t` / body / secret-name used).
- The MediFlow API base URL or `ORG_ID` is unknown / ambiguous.
