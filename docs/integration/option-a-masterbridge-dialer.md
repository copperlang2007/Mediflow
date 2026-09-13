# Option A — MasterBRIDGE Dialer Integration (API/Event Boundary)

**Status:** Proposed
**Target home:** MediFlow `main` (MediFlow is the surviving platform and system of record)
**Companion repo:** `copperlang2007/masterBRIDGE` keeps its current **v1** (Python FastAPI complaint-ops + the `masterbridge-v2` TypeScript dialer) in its own repo. We integrate a *version* of the masterBRIDGE-v2 dialer as a downstream **execution service**; we do not merge repos.

---

## 1. Goal & guiding principles

Integrate masterBRIDGE's outbound **power dialer** (Twilio calling, dispositions, transcription, TCPA/DNC/calling-hours logic) with MediFlow **without** importing masterBRIDGE's weaker security posture, and without making MediFlow depend on masterBRIDGE's identity model, ID scheme, or runtime.

Principles:

1. **MediFlow is the single source of truth.** Identity (Clerk), tenancy (`org_id`), contacts/PHI, leads, consent/DNC state, agent licensing/eligibility, dispositions catalogue, and the audit trail all live in MediFlow.
2. **The dialer is a stateless execution service.** It receives a short-lived, minimal **Dial Ticket**, places the call, emits lifecycle events, and returns the outcome. It is not a system of record and stores no long-lived PHI.
3. **PHI minimization at the boundary.** The Medicare Beneficiary Identifier (MBI) is *never* sent to the dialer — it is not needed to place a call. Only the data required to dial and to stay compliant crosses the boundary.
4. **Integrate at the API/event boundary only.** No shared database, no cross-schema foreign keys, no shared auth library. The two systems are coupled solely through versioned HTTP + signed webhooks.
5. **Compliance is decided in MediFlow, enforced at the dialer.** MediFlow pre-clears every call (consent, DNC, calling hours, agent eligibility) and stamps the ticket; the dialer refuses to dial a ticket without a valid pre-clearance.

```
            ┌─────────────────────────── MediFlow (main, system of record) ───────────────────────────┐
            │  Clerk auth · org/tenancy · contacts+PHI(MBI encrypted) · leads · agents/licensing       │
            │  consent+DNC truth · disposition catalogue · audit · AI (OpenAI/Azure, HIPAA-gated)      │
            └───────────┬───────────────────────────────────────────────────────▲──────────────────────┘
                        │  (1) provision Dial Ticket  (signed, time-boxed)        │ (2) lifecycle events,
                        │      + compliance pre-clearance                         │     disposition, transcript
                        ▼                                                         │     (HMAC-signed webhooks)
            ┌───────────────────────── masterBRIDGE Dialer Service (stateless) ──┴──────────────────────┐
            │  Twilio calling · media streams · live transcription · ephemeral call-session state only   │
            └────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Ownership matrix (who owns what)

| Domain | Owner | Notes |
|---|---|---|
| User identity / login | **MediFlow (Clerk)** | Dialer has **no** user login. Drop `masterbridge-v2` JWT/bcrypt auth (`artifacts/api-server/src/lib/auth.ts`, `users`, `sessions` tables). |
| Tenancy (`org_id`) | **MediFlow** | Every ticket/event carries `orgId`. Dialer is multi-tenant only by tagging. |
| Contact + PHI (MBI) | **MediFlow** | `contactsTable` with `medicare_id_encrypted` + `medicare_id_hash`. MBI never leaves MediFlow. |
| Lead / pipeline | **MediFlow** | `leadsTable`, `contactsTable`, pipelines/deals. Dialer's `leads` table is **not** a source of truth. |
| Agent licensing / certs / AHIP | **MediFlow** | Eligibility (`stateLicensesTable`, `carrierCertificationsTable`, `ahipRecordsTable`) gates dialing. |
| Consent / DNC / calling-hours truth | **MediFlow** | Dialer's `lib/compliance.ts` checks become a *secondary* guardrail, not the decision. |
| Disposition catalogue | **MediFlow** | Dialer reports a `code`; MediFlow owns the canonical list (incl. `COMPLIANCE` category). |
| Call placement / Twilio | **Dialer** | Twilio SID, media streams, RTP, recording. |
| Live transcription | **Dialer (capture) → MediFlow (store/parse)** | Transcript text pushed to MediFlow; AI parsing runs in MediFlow (PHI stays BAA-covered). |
| Audit trail | **MediFlow** | All call/disposition/compliance events land in MediFlow audit via `auditMiddleware`. |

---

## 3. Correlation & ID mapping

MediFlow uses `text` (prefixed) primary keys + `org_id` everywhere; masterBRIDGE-v2 uses `serial` integers with no tenancy. We **do not** reconcile PKs. Instead:

- MediFlow mints a **`dialTicketId`** (UUID) for every dial request — this is the correlation key across both systems.
- The dialer stores MediFlow identifiers as **opaque external refs** (`text`), never as foreign keys: `mediflow_org_id`, `mediflow_contact_id`, `mediflow_agent_id`, `dial_ticket_id`.
- MediFlow stores the dialer's returned `dialerCallId` on its own call-activity record for traceability.

### 3.1 Field mapping (masterBRIDGE-v2 → MediFlow)

| masterBRIDGE-v2 (`artifacts/lib/db/src/schema`) | MediFlow (`lib/db/src/schema`) | Disposition in Option A |
|---|---|---|
| `leads.id` (serial) | `contactsTable.id` / `leadsTable.id` (text) | Map via `dialTicketId`; dialer keeps `mediflow_contact_id` as opaque ref. |
| `leads.firstName/lastName/phone/email/state/zipCode` | `contactsTable.firstName/lastName/phone/email/stateCode/zipCode` | Sent into the ticket (minimal subset; see §5.1). |
| `leads.medicareId` (plaintext varchar) | `contactsTable.medicare_id_encrypted` (+ `_hash`) | **DROP from boundary.** MBI never sent to dialer. |
| `leads.tcpaConsent / dncListed` | MediFlow consent/DNC state | MediFlow decides; ticket carries a boolean **pre-clearance**, not raw flags. |
| `leads.soaStatus` (SOA) | MediFlow (SOA owned by MediFlow e-sign/`esign.ts`) | Ticket carries `soaRequired`/`soaOnFile`; SOA capture stays in MediFlow. |
| `leads.dialAttempts / lastDialedAt` | MediFlow call-activity aggregates | MediFlow computes attempts/cooldown; dialer enforces as guardrail. |
| `calls.*` (twilioSid, status, duration, dispositionCode, transcript, extractedData) | MediFlow call-activity + `communications`/`activities` | Pushed back via `call.*` events (§6). |
| `disposition_codes.*` | MediFlow disposition catalogue | MediFlow owns; dialer fetches/caches the active list. |
| `users.* / sessions.*` (JWT/bcrypt) | MediFlow `core` users + Clerk | **Removed** from dialer. |

---

## 4. Auth & trust model (Clerk ↔ dialer)

No shared auth library. Two trust channels:

1. **Service-to-service (control plane).** MediFlow → dialer and dialer → MediFlow calls are authenticated with **short-lived signed service JWTs** (asymmetric; MediFlow publishes a JWKS, dialer verifies; dialer holds its own signing key for callbacks). Mutual TLS optional at the network layer.
2. **Webhook integrity.** Every dialer → MediFlow webhook is **HMAC-SHA256 signed** (`X-MB-Signature: t=<ts>,v1=<hmac>`) with a per-tenant shared secret, timestamp-bound (±5 min) to prevent replay. This mirrors MediFlow's existing Twilio webhook signature handling in `artifacts/api-server/src/routes/webhooks.ts`.
3. **Agent identity propagation.** Agents authenticate **only to MediFlow (Clerk)**. The dialer has no login. When an agent opens the dialer UI (embedded or linked), MediFlow mints a **short-lived dialer session token** (scoped to `orgId` + `agentId`, ≤15 min, refreshable) that the dialer verifies via JWKS. The dialer's existing `jose`-based JWT verification is repointed at MediFlow's JWKS; bcrypt password storage and the `users`/`sessions` tables are deleted.

---

## 5. API contract — MediFlow → Dialer (control plane)

Base path on the dialer service: `/dialer/v1`. All requests carry a service JWT (`Authorization: Bearer <jwt>`) and `Idempotency-Key`.

### 5.1 `POST /dialer/v1/tickets` — provision a Dial Ticket

Minimal, time-boxed, pre-cleared. **No MBI.**

```json
{
  "dialTicketId": "dt_01J9Z8M3...",          // UUID, correlation key
  "orgId": "org_2abc…",                        // MediFlow tenant
  "agentId": "agt_2def…",                      // MediFlow agent (Clerk-backed)
  "contactRef": "con_2ghi…",                   // opaque MediFlow contact id
  "callee": {
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "+15035551234",                   // E.164
    "stateCode": "OR",
    "zipCode": "97201",
    "preferredLanguage": "en"
  },
  "compliance": {                              // MediFlow's DECISION, not raw flags
    "precleared": true,
    "preclearedAt": "2026-05-31T17:02:11Z",
    "preclearanceId": "pc_01J9…",              // auditable, references MediFlow audit row
    "tcpaConsentOnFile": true,
    "dncClear": true,
    "withinCallingHours": true,
    "soaRequired": true,
    "soaOnFile": false,
    "agentEligible": true,                      // licensed+certified for this state/product
    "expiresAt": "2026-05-31T17:32:11Z"         // ticket TTL; dialer refuses after expiry
  },
  "campaignId": "cmp_…",                        // optional
  "callbackUrl": "https://app.mediflow…/api/dialer/v1/events"
}
```

Response `201`: `{ "dialerTicketId": "...", "status": "QUEUED" }`.

### 5.2 `POST /dialer/v1/calls` — start a call now (click-to-dial)

Body: `{ "dialTicketId": "dt_…" }`. Returns `{ "dialerCallId": "...", "status": "INITIATED" }`. Dialer **must** re-validate `compliance.precleared && now < expiresAt` and, as a guardrail, re-run `lib/compliance.ts` checks; on failure returns `409 COMPLIANCE_BLOCKED` and emits `call.compliance.flagged`.

### 5.3 `DELETE /dialer/v1/tickets/{dialTicketId}` — revoke

Used when MediFlow detects a consent withdrawal / DNC add / license lapse after issue. Idempotent; dialer cancels any queued/in-flight attempt.

### 5.4 `GET /dialer/v1/calls/{dialerCallId}` — status (reconciliation)

Read-only status fetch for MediFlow to reconcile if a webhook is missed.

### 5.5 `GET /dialer/v1/healthz` / `GET /dialer/v1/readyz`

Standard liveness/readiness.

---

## 6. Event contract — Dialer → MediFlow (webhooks)

MediFlow exposes **`POST /api/dialer/v1/events`** (new route, sibling to `webhooks.ts`). All events HMAC-signed (§4.2), idempotent on `eventId`, and land in the MediFlow audit log. Envelope:

```json
{
  "eventId": "evt_01J9…",
  "schemaVersion": 1,
  "type": "call.completed",
  "occurredAt": "2026-05-31T17:09:44Z",
  "orgId": "org_2abc…",
  "dialTicketId": "dt_01J9…",
  "dialerCallId": "call_…",
  "data": { /* type-specific */ }
}
```

Event types & `data` payloads:

| `type` | `data` | MediFlow action |
|---|---|---|
| `call.initiated` | `{ twilioSid }` | open call-activity row, link to contact via `dialTicketId` |
| `call.ringing` | `{}` | status update |
| `call.in_progress` | `{ answeredAt }` | status update |
| `call.completed` | `{ duration, endedReason }` | finalize activity, update lead/pipeline |
| `call.failed` | `{ reason }` ("NO_ANSWER"\|"BUSY"\|"FAILED"\|"VOICEMAIL") | record outcome, schedule retry per MediFlow cooldown |
| `call.disposition.recorded` | `{ code, category, notes }` | map to canonical disposition; if `category=COMPLIANCE` raise oversight task |
| `call.transcript.ready` | `{ transcriptText, redacted: bool, segments? }` | store (encrypted), kick AI parsing **in MediFlow** (§8) |
| `call.transcript.purged` | `{ purgedAt, transcriptHash }` | mark transcript purge-confirmed on the call record (§6.1) |
| `call.compliance.flagged` | `{ rule, detail }` ("TCPA"\|"DNC"\|"CALLING_HOURS"\|"MAX_ATTEMPTS"\|"COOLDOWN") | block, alert compliance_manager, audit |

### 6.1 Transcript handling & purge (operational)

The dialer pushes the transcript to MediFlow and then **purges its own copy**. AI parsing/agent-assist runs inside MediFlow so PHI stays within the BAA-covered platform (§8). To make this enforceable rather than aspirational:

- **Configurable retention knob.** Dialer env `DIALER_TRANSCRIPT_RETENTION_HOURS` (default `24`, max `72`). A background sweep purges any transcript older than the window whose `call.transcript.ready` has been **acknowledged** by MediFlow (2xx on the webhook). Transcripts are never purged before a confirmed handoff, to avoid data loss.
- **Purge confirmation is an event, not a hope.** On successful purge the dialer emits `call.transcript.purged` carrying `purgedAt` and a `transcriptHash` (SHA-256 of the transcript text MediFlow received). MediFlow verifies the hash matches the stored transcript and sets a `transcriptPurgeConfirmedAt` timestamp on the call record. A call whose transcript was delivered but lacks a purge confirmation past `retention + grace` is flagged.
- **Failure surfacing.** A purge failure (or a missing confirmation past the grace window, default 6h) raises a **compliance alert** to `compliance_manager` via MediFlow notifications and writes an audit row — it is treated as a compliance incident, not a silent retry.
- **Verification / reconciliation.** A scheduled MediFlow job (`pg-boss`) reconciles: for every `call.transcript.ready` it expects a matching `call.transcript.purged` within the window; gaps are surfaced on the compliance dashboard. The dialer also exposes `GET /dialer/v1/calls/{dialerCallId}` (§5.4) returning `transcriptRetained: bool` so MediFlow can spot-audit that no copy lingers.
- **Belt-and-suspenders:** transcripts at rest in the dialer (within the retention window) are encrypted; the dialer holds no other PHI, and the MBI never reaches it (§3.1).

### 6.2 API versioning & backward-compatibility

`/dialer/v1` (§5), the event types and envelope (§6), and the Dial Ticket payload (§5.1) form a **formal boundary contract** between two independently deployed services. Rules:

- **Versioned in the path + the envelope.** The HTTP surface is versioned in the URI (`/dialer/v1`, `/api/dialer/v1`). Every event also carries an explicit `schemaVersion` field in the envelope (add to §6) so consumers can branch without sniffing shape.
- **Additive changes are non-breaking and require no version bump.** Adding a new optional field, a new event `type`, or a new disposition code is backward-compatible. **Consumers must ignore unknown fields and unknown event types** (forward-compatible parsing) — this is a hard requirement on both sides and is asserted in the contract tests (§10, Phase 2).
- **Breaking changes bump the major version.** Removing/renaming a field, changing a type/enum's meaning, or changing required-ness is breaking and ships as `/dialer/v2` (and `schemaVersion: 2`). `v1` and `v2` run **side by side** through a deprecation window; the issuer negotiates via an `Accept-Version`/`X-MB-Api-Version` header, defaulting to the lowest still-supported major.
- **Deprecation policy.** A deprecated version is announced in this doc's changelog and signalled at runtime with a `Deprecation` + `Sunset` response header (RFC 8594) and a structured warning in logs/audit. Minimum support window: **2 minor releases or 90 days**, whichever is longer, after the successor ships.
- **Discovery & drift detection.** The contract lives in MediFlow's OpenAPI spec (`lib/api-spec`, consumed by Orval). CI runs a **schema-diff gate** on the spec: any non-additive change fails the build unless the major version is bumped, so breaking changes can't merge silently. The dialer pins the contract version it implements and reports it via `GET /dialer/v1/healthz` (`{ contractVersion }`) so MediFlow can detect a mismatched deploy.
- **Idempotency & ordering are part of the contract, not the version.** `Idempotency-Key` (requests) and `eventId` (events) dedupe across retries; consumers must tolerate out-of-order and duplicate delivery regardless of version.

---

## 7. Replit removal plan (file-by-file)

All Replit coupling is removed from MediFlow. References found in the repo today and their disposition:

| Path | Replit coupling | Action |
|---|---|---|
| `.replit` | Replit runtime, `python-3.11` module, autoscale deploy, ports, postMerge hook | **Delete.** Replace deploy target with container/Docker (reuse masterBRIDGE's Postgres/Redis/MinIO `docker-compose` pattern). |
| `.replitignore` | Replit packager hints | **Delete.** |
| `replit.md` | Replit-flavored architecture doc | **Rename → `docs/ARCHITECTURE.md`**, strip Replit-isms (Object Storage, AI Integrations proxy). |
| `pnpm-workspace.yaml` | Replit references | Remove Replit-specific entries; keep workspace globs. |
| `lib/integrations/openai_ai_integrations/**`, `lib/integrations-openai-ai-server/**`, `lib/integrations-openai-ai-react/**` | "Replit AI Integrations" proxy used as the **dev** `AI_INTEGRATIONS_OPENAI_BASE_URL` | Keep the OpenAI/Azure client; **remove the Replit-proxy default base URL.** Dev → standard OpenAI; prod → Azure OpenAI (HIPAA guard already enforces this in `buildClient.ts` + `lib/aiProvider.ts`). See §8. |
| `artifacts/api-server/src/lib/objectStorage.ts` | **Replit Object Storage** client | Replace with **S3-compatible** storage (AWS S3 in prod, MinIO in dev). New env: `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Keep private-ACL + presigned-URL semantics. |
| `lib/object-storage-web/**` | Replit storage client | Repoint to S3 presigned URLs. |
| `artifacts/api-server/src/index.ts`, `app.ts` | Replit port/host bootstrapping | Use standard `PORT`/`HOST` env; remove Replit-specific wiring. |
| `artifacts/api-server/src/routes/webhooks.ts` | Replit storage on inbound media | Route media to S3; keep Twilio signature verification. |
| `artifacts/web-app/vite.config.ts`, `artifacts/mockup-sandbox/vite.config.ts` | Replit Vite plugins (cartographer / runtime-error-modal) | Remove Replit plugins + their deps from the respective `package.json`. |
| `artifacts/web-app/package.json`, `artifacts/mockup-sandbox/package.json` | `@replit/*` devDeps | Remove. |
| `artifacts/web-app/src/components/ui/button.tsx`, `badge.tsx` | Replit references (comments/utilities) | Clean references. |

**Net new infra:** S3-compatible bucket + (for local) MinIO in `docker-compose`. Deployment moves off Replit autoscale to the team's container host; `scripts/post-merge.sh` (was `[postMerge]`) becomes a CI step.

---

## 8. AI provider consolidation — decision: **OpenAI (Azure OpenAI for prod/PHI)**

**Decision:** consolidate on **OpenAI**, with **Azure OpenAI** as the production / PHI path. Drop Anthropic from the integration target.

**Why this fits the use case best (evidence from the code, not preference):**

1. **Already HIPAA-BAA-gated in the surviving platform.** `lib/integrations-openai-ai-server/src/buildClient.ts` and `artifacts/api-server/src/lib/aiProvider.ts` already hard-fail in production unless `AI_INTEGRATIONS_PROVIDER=azure` — Azure OpenAI is the BAA-covered provider. The PHI guardrail exists today and is the right one to keep.
2. **Multimodal coverage MediFlow actually uses.** The OpenAI integration powers chat (`gpt-5.4`), **TTS (`gpt-audio`)** for the onboarding tour, image, and batch. Anthropic offers none of TTS/image/batch — consolidating on Anthropic would *delete* working features. Consolidating on OpenAI loses nothing.
3. **Nothing to migrate from the dialer.** masterBRIDGE-v2's README claims "Anthropic Claude," but there is **no Anthropic implementation on disk** in `masterbridge-v2` (no client, no route, no `claude-*` usage). So "consolidation" is really "do not introduce a second provider."

**Concrete changes:**

- **Remove the Replit proxy** from the AI client dev path (§7). Dev → standard OpenAI base URL; prod → Azure OpenAI (unchanged guard).
- **Single AI entry point:** all AI calls (chat, draft, compliance report, **plus** the dialer's planned agent-assist and transcript parsing) go through `buildOpenAIClient()` / `aiProvider.ts`.
- **Transcript parsing & agent-assist run inside MediFlow**, invoked on `call.transcript.ready` (§6), so PHI stays inside the Azure-OpenAI BAA boundary. The dialer never calls an LLM directly with PHI.
- **Env after consolidation:** `AI_INTEGRATIONS_PROVIDER` (`openai`|`azure`), `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL` (no Replit), Azure: `AI_INTEGRATIONS_AZURE_RESOURCE`, `AI_INTEGRATIONS_AZURE_DEPLOYMENT`, `AI_INTEGRATIONS_AZURE_API_VERSION`.

> **Recorded alternative:** if the team later wants Claude's long-context compliance reasoning, the BAA-clean route is **Anthropic via AWS Bedrock**, added *behind* `aiProvider.ts` as a third provider value — not by splitting providers across services. Not part of Option A.

---

## 9. Compliance hardening at the boundary

The dialer's `lib/compliance.ts` is fine as a *guardrail* but must not be the decision-maker:

- **Calling hours:** the existing check is explicitly **not DST-aware** and silently passes unknown states. MediFlow performs the authoritative calling-hours decision (DST-correct, per callee timezone) at preclearance; the dialer re-check is a backstop only.
- **Consent/DNC:** MediFlow holds the canonical consent ledger + DNC; the ticket carries the decision (`precleared`) with an auditable `preclearanceId`. The dialer never relies on its own `leads.tcpaConsent/dncListed`.
- **MBI/PHI:** never crosses the boundary (§3.1). Transcripts are pushed back and purged from the dialer (§6).
- **Audit:** every event lands in MediFlow's audit (`auditMiddleware`), giving one immutable, tenant-scoped trail across both systems.

---

## 10. Phased delivery

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spec sign-off** | This document | Stakeholders approve ownership matrix + contracts |
| **1. De-Replit + AI consolidation** | §7 + §8 in MediFlow `main` (own PR) | No `@replit/*` deps, no `.replit*`; storage on S3/MinIO; AI through `aiProvider.ts`; `pnpm typecheck` + `pnpm test` green |
| **2. Contract scaffolding** | Add `/api/dialer/v1/events` route + OpenAPI entries (Orval); service-JWT + HMAC verification; dial-ticket issuance + preclearance service | Contract tests pass against a mock dialer |
| **3. Dialer service onboarding** | Stand up masterBRIDGE-v2 as a service: strip JWT/bcrypt auth + `users`/`sessions`, repoint `jose` to MediFlow JWKS, add `mediflow_*`/`dial_ticket_id` external-ref columns, purge-on-push transcript handling | Dialer places a call from a MediFlow-issued ticket end-to-end in staging |
| **4. Eligibility + compliance wiring** | Preclearance pulls licensing/cert/AHIP + consent/DNC/calling-hours; `COMPLIANCE` dispositions raise oversight tasks | A non-licensed/non-consented dial is blocked and audited |
| **5. AI agent-assist + transcript parsing** | `call.transcript.ready` → MediFlow AI (Azure) parse + agent-assist | Transcript parsed in-platform; no PHI sent to dialer's LLM path |
| **6. Hardening** | Idempotency, replay protection, reconciliation job (§5.4), load test (`load-tests/`) | SLOs met; failure/missed-webhook recovery verified |

---

## 11. Open decisions for the team

1. **Dialer UI surface:** embed the dialer React app inside MediFlow (iframe/module-federation) vs. link out with a minted session token (§4.3). Affects Phase 3.
2. **Dialer hosting & BAA:** where the dialer service runs and whether it needs its own BAA even though it holds no MBI and only transient transcripts (recommend yes if transcripts can contain PHI before purge).
3. **Storage vendor for Phase 1:** AWS S3 (recommended for prod) vs. another S3-compatible provider; MinIO assumed for local.
4. **Transcript retention window** in the dialer (default proposed: 24h, then purge).
5. **Campaign/queue ownership:** does MediFlow drive the dial queue (recommended), or does the dialer pull? §5 assumes MediFlow-driven push.

---

## 12. What this explicitly does *not* do

- Does **not** merge the masterBRIDGE Python complaint-ops / delegated-oversight engine (that stays in masterBRIDGE; integrate later via API if desired).
- Does **not** merge databases or reconcile primary keys.
- Does **not** keep any masterBRIDGE auth, user store, or plaintext MBI.
- Does **not** introduce a second AI provider.
