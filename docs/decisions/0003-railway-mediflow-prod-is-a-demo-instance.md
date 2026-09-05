# 3. The `mediflow-prod` Railway service is a demo instance, not a PHI production instance

## Status

Accepted — 2026-09-05

## Context

The Railway project named `mediflow-prod` (service `Mediflowapi`, environment
`production`) was returning `502 Application failed to respond` on every public
request, while its own deploy logs showed a fully healthy process: web bundle
served, pg-boss started, all background workers registered, and internal
`/api/healthz` returning 200.

Two things came out of diagnosing that outage.

**1. The 502 was a port mismatch.** `artifacts/api-server/src/index.ts` requires
`PORT` and refuses to boot without it; the service had `PORT=3000`, while the
Railway-generated service domain `mediflowapi-production.up.railway.app` routes
to `targetPort: 8080`. The app listened on 3000, the edge proxy dialed 8080, and
every request 502'd before reaching Node. Nothing in the application was wrong.

**2. The service is not a production PHI environment, despite its name.** The
deploy logs are pino-pretty colorized output, which `lib/logger.ts` emits only
when `NODE_ENV !== "production"`. `DEMO_MODE=true` and `DEMO_USER_ID` are set,
and `assertProdEnvIntegrity` (`lib/prodEnvGuard.ts`) refuses to boot if
`DEMO_MODE=true` is paired with `NODE_ENV=production`, a live Clerk key, or an
explicit `PHI_ENCRYPTION_KEY`. The service boots, so none of those are present.

This matters for the original question — "fill out the env requirements" —
because the naive fill-out (generate `PHI_ENCRYPTION_KEY` / `PHI_HMAC_KEY`, add
live Clerk keys) would either crash the service on the next boot or, worse,
silently place real PHI behind an authentication bypass. `isDemoMode()` resolves
*every* request to a single seeded super_admin user.

## Decision

Treat `mediflow-prod` as the design-partner demo deployment. Its environment is
filled out to the demo contract, not the HIPAA production contract:

- `PORT=8080` — align with the service domain's `targetPort`. One variable, no
  domain edit, and it matches Railway's own convention.
- `CARRIER_EMAIL_CONNECTOR_DRY_RUN=true` — `emailConnector.ts` throws without
  `RESEND_API_KEY`; dry-run is the correct demo value and, more importantly,
  guarantees a walkthrough can never transmit a real carrier appointment
  request.
- `LOG_LEVEL=info` — pin the level that was previously an implicit default.

Deliberately **not** set on this service:

- `PHI_ENCRYPTION_KEY`, `PHI_HMAC_KEY` — the prod-env guard treats an explicit
  PHI key as production-looking and hard-fails when paired with `DEMO_MODE`.
  There is also no key-version prefix in the ciphertext format
  (`lib/db/src/encryption/medicareId.ts`), so introducing a key is a one-way
  door for any row already written.
- Live Clerk keys (`pk_live` / `sk_live`) — same guard, same reason.
- `RESEND_API_KEY` — invitation email degrades gracefully: `email.ts` returns
  "not sent" and the invitations route surfaces a copyable accept URL, which the
  team page already renders. A demo does not need outbound mail.
- `PRIVATE_OBJECT_DIR`, `AI_INTEGRATIONS_*` credentials, Twilio, Sentry — these
  belong to a real production service that does not exist yet.

A HIPAA production environment is a **separate** Railway service (or a separate
Railway environment) with `DEMO_MODE` absent, `NODE_ENV=production`, and the full
secret set. It is not this one with more variables added.

## Alternatives Considered

- **Change the domain's `targetPort` to 3000.** Equivalent outcome, but it edits
  networking rather than configuration and diverges from Railway's default.
- **Generate PHI keys now and set `NODE_ENV=production`.** Rejected: it would
  trip the prod-env guard on `DEMO_MODE`, and the auth bypass makes real
  credentials on this service actively dangerous.
- **Leave the missing variables as-is.** Rejected for
  `CARRIER_EMAIL_CONNECTOR_DRY_RUN`: without it, a demo submission either throws
  or (once a Resend key is ever added) emails a real carrier.

## Reasoning

The guards in this codebase already encode the right policy — `prodEnvGuard`,
`isDemoMode`, `assertAiProviderHipaaCompliant`, and the `medicareId` key loader
all refuse the dangerous combinations. The correct action was to read what they
permit and configure inside it, rather than to fill every empty variable.

The service name `mediflow-prod` is the trap: it says production and behaves as
a demo. This ADR exists mainly so the next person does not resolve that conflict
by adding secrets.

## Tradeoffs

The demo runs with an auth bypass and dev-sentinel PHI keys. That is acceptable
only because it must never hold real beneficiary data — a constraint that is now
enforced by code and recorded here, not by memory. Anyone seeding this instance
must use synthetic data.

## Master Data Flywheel Impact

Adds a deployment-configuration record: the mapping from service identity
(demo vs. production) to the required env contract. Future deploys can be
validated against it instead of rediscovering the guards by crashing.

## New Data Flywheel Impact

None. This is a contribution to the existing deployment-records stream.

## Moat Impact

Neutral-to-positive. The defensible asset is the guard layer itself — a
codebase that refuses to run an auth bypass in front of PHI, and refuses to
process PHI under a dev sentinel key. This ADR documents that the guards work
in practice, on a live deployment, which is evidence rather than assertion.

## Security / Compliance Impact

Material and positive:

- Closes a live outage without weakening any guard.
- `CARRIER_EMAIL_CONNECTOR_DRY_RUN=true` removes the possibility of a demo
  walkthrough transmitting a real carrier appointment request.
- Records, in writing, that `mediflow-prod` is not HIPAA-eligible and must not
  receive PHI, live Clerk keys, or real PHI encryption keys.

Open: the ciphertext format has no key-version prefix, so PHI key rotation is
currently destructive. That must be solved before the real production
environment stores its first Medicare ID.

## Reversibility

Easy. All three variables are single-value changes; reverting `PORT` to 3000
restores the previous (broken) state.

## Evidence

- Before: `curl https://mediflowapi-production.up.railway.app/version` →
  `{"status":"error","code":502,"message":"Application failed to respond"}`
- After: `GET /version` → `200 {"version":"1","nodeVersion":"v24.20.0",...}`
- After: `GET /api/readyz` → `200 {"status":"ok","checks":{"db":"ok","workers":"ok"}}`
- Deploy log evidence of a healthy-but-unreachable process, and of
  pino-pretty output implying `NODE_ENV !== "production"`.

## Follow-Up Actions

1. Add a key-version prefix to the `medicare_id_encrypted` format so PHI key
   rotation stops being a one-way door.
2. Stand up the real production environment separately: `NODE_ENV=production`,
   no `DEMO_MODE`, PHI keys from Secret Manager, Identity Platform rather than
   Clerk (Phase 2), `PRIVATE_OBJECT_DIR` on a BAA-covered GCS bucket.
3. Consider renaming the Railway project so `prod` does not name a demo.
4. Verify the seeded data in this instance is entirely synthetic.
