# 4. Google Cloud Run + Cloud SQL is the production deployment target

## Status

Proposed — 2026-09-08. Config and CI are built and merged; the underlying
GCP project has not yet been provisioned (see Follow-Up Actions). Promote to
Accepted once `scripts/deploy/gcp-bootstrap.sh` has been run and a real
deploy has gone live.

## Context

ADR 0003 already established that the Railway `mediflow-prod` service is a
permanent human-testing/demo instance and that "the true production app will
not live on Railway." `render.prod.yaml` exists as a second candidate
production path but has not been operated. The operator asked directly for
the real production deployment to run on Google Cloud.

Two things about the existing codebase made the target obvious rather than
arbitrary:

1. **Object storage already targets GCS.** `objectStorage.ts` constructs
   `new Storage()` from `@google-cloud/storage` and resolves credentials via
   Application Default Credentials — a GCP-native pattern. Running on Render
   or Railway means shipping a long-lived `GOOGLE_APPLICATION_CREDENTIALS`
   JSON key as a cross-cloud secret (documented as a "known caveat" in
   `docs/DEPLOY_RENDER_PRODUCTION.md`). Running on GCP compute removes that
   key entirely — the platform's own service account identity satisfies ADC.
2. **The app is a single stateless container with an HTTP health check**
   (`/api/healthz`, reads `PORT` from the environment, migrations serialize
   under a Postgres advisory lock). That shape maps directly onto Cloud Run;
   there was no architectural reason to reach for GKE or Compute Engine.

## Decision

Stand up production on:

- **Cloud Run** (`mediflow-prod`) running a dedicated production image
  (`docker/Dockerfile.prod`) — not the repo-root `Dockerfile`, which is an
  explicitly demo-mode build (`VITE_DEMO_MODE=true`, seeds demo data on every
  boot) and would have silently shipped demo mode to production if reused.
- **Cloud SQL for PostgreSQL 16**, no public IP, reached over the private
  Cloud SQL Unix socket Cloud Run mounts via `--add-cloudsql-instances`.
- The existing **GCS object storage**, unchanged in application code — only
  the credential mechanism improves (ADC via the Cloud Run service account
  instead of a JSON key).
- **Secret Manager** for every credential and the generated PHI/crypto keys,
  mounted into the Cloud Run revision with `--set-secrets` (never as plain
  `--set-env-vars`).
- **Workload Identity Federation** for GitHub Actions → GCP auth, so no
  service-account JSON key is stored in GitHub Secrets at all.
- **AI stays on AWS Bedrock**, unchanged. `aiProvider.ts`'s HIPAA guard only
  permits `azure`/`bedrock` in production; Cloud Run calls Bedrock's
  OpenAI-compatible endpoint over the public internet exactly as Render does
  today. Migrating to Vertex AI's hosted Anthropic models is a live option
  later, but it's an AI-vendor decision independent of where the container
  runs, and changing it now would have widened this change's blast radius
  for no requirement that forced it.

## Alternatives Considered

- **GKE (Kubernetes).** Rejected: the app is one stateless container behind
  one health check with no need for custom scheduling, sidecars, or
  multi-container pods. Kubernetes would add operational surface (cluster
  upgrades, node pools, RBAC) with no corresponding capability agencyBRIDGE uses.
- **Compute Engine (VMs).** Rejected: reintroduces OS patching and instance
  lifecycle management that Cloud Run's managed runtime removes for free,
  for an app with no requirement (GPU, custom kernel, long-lived TCP state)
  that needs a VM.
- **Keep Bedrock cross-cloud vs. migrate to Vertex AI now.** Deferred rather
  than decided against — see Follow-Up Actions. Bundling an AI-provider
  migration into the hosting migration would make either change harder to
  verify or roll back independently.
- **Neon (per the global CLAUDE.md "Neon is source of truth" default) vs.
  Cloud SQL.** Cloud SQL was chosen for this repo specifically: it is the
  HIPAA-eligible, GCP-native pairing with Cloud Run (private-IP-only, BAA
  under Google Cloud's own compliance program), and the existing Render/
  Railway paths already use bespoke managed Postgres rather than Neon, so
  there was no established Neon dependency here to preserve. This is a
  repo-level override of the global default, recorded here rather than
  silently diverging from it.

## Reasoning

Cloud Run is the smallest infrastructure surface that satisfies every
existing constraint in the code (stateless container, `PORT` env,
`/api/healthz`, lock-safe concurrent migrations) while directly resolving a
real, documented weakness in the current Render path (the GCS credential
key). Choosing it is not infrastructure-for-its-own-sake — it removes a
credential that currently has to exist.

## Tradeoffs

- **Two more platforms to operate** (Cloud Run + Cloud SQL) alongside
  Render/Railway, until/unless those are decommissioned — deliberately not
  done here (see the PR's scope cuts) so this path can be validated
  independently before anything live is turned off.
- **Cross-cloud AI calls persist.** Every AI request still leaves GCP for
  AWS Bedrock; this is a latency/complexity cost accepted to keep this
  change scoped to hosting, not AI vendor.
- **No custom domain / WAF in this pass.** The service is reachable at its
  `*.run.app` URL only, by design (see PR scope cuts) — acceptable for
  validating the path, not for a public-beneficiary-facing launch.

## Master Data Flywheel Impact

Adds a deployment-configuration record analogous to ADR 0003: the mapping
from GCP resource identity (Cloud Run service, Cloud SQL instance, PHI
bucket, service accounts, WIF pool) to the required secret/env contract, all
committed as inspectable config (bootstrap + deploy scripts) rather than
console clicks. Future deploys, audits, and onboarding read this instead of
rediscovering GCP state by trial and error.

## New Data Flywheel Impact

None new — contributes to the existing deployment-records stream alongside
the Render and Railway ADRs/docs.

## Moat Impact

Neutral. This is table-stakes infrastructure, not a differentiated asset —
any competitor can stand up Cloud Run + Cloud SQL identically. The
defensible layer remains the application's own HIPAA guard code
(`prodEnvGuard.ts`, `aiProvider.ts`, `objectStorage.ts`'s boot check,
`migrate-locked.ts`), which this deployment path exercises but does not
create. Recorded for completeness, not claimed as a moat.

## Security / Compliance Impact

Material and positive:

- Removes the need for a long-lived `GOOGLE_APPLICATION_CREDENTIALS` JSON
  key anywhere in the deploy pipeline (Cloud Run ADC replaces it).
- Cloud SQL has no public IP; the database is unreachable except through the
  Cloud Run-mounted private socket.
- No GCP service-account key is stored in GitHub Secrets — Workload Identity
  Federation issues short-lived tokens scoped to this exact repository.
- PHI/crypto secrets live in Secret Manager, generated once by the bootstrap
  script and never rewritten by the deploy script — the same "must never
  rotate" invariant `docs/DEPLOY_RENDER_PRODUCTION.md` already documents for
  the Render path, now enforced by the script's own idempotency check rather
  than operator discipline alone.
- Both service accounts are scoped narrowly (runtime SA: Cloud SQL client +
  Secret Manager access + object admin on the PHI bucket only, not the
  project; deploy SA: Cloud Run deploy + Artifact Registry write + `actAs`
  the runtime SA only) rather than granted `roles/editor` or `roles/owner`.
- **Not yet independently verified**: no real GCP project has been
  provisioned against this config yet (see Follow-Up Actions) — this ADR
  documents the design, not an audited running system.

## Reversibility

Easy, in the sense that stands up a new path without touching the existing
ones: deleting the Cloud Run service, Cloud SQL instance, and associated IAM
bindings fully removes this deployment with zero effect on Render/Railway.
Costly only once real beneficiary PHI has been written to the Cloud SQL
database and needs migrating elsewhere — not yet the case.

## Evidence

- Code read confirming Cloud-Run compatibility with no application changes:
  `artifacts/api-server/src/index.ts` (dynamic `PORT`, no host binding
  restricting to loopback), `lib/db/src/migrate-locked.ts` (advisory-lock
  serialized migrations, safe under concurrent cold starts),
  `artifacts/api-server/src/lib/objectStorage.ts` (ADC-based GCS client,
  already GCP-native).
- `docs/DEPLOY_RENDER_PRODUCTION.md`'s own "Known caveat — object storage"
  section, which this ADR's chosen path structurally resolves.
- `bash -n` syntax validation and YAML parsing of every new script/workflow
  in the companion PR — no execution evidence yet (no `gcloud` credentials in
  this environment).

## Follow-Up Actions

1. Run `scripts/deploy/gcp-bootstrap.sh` from a machine with `gcloud` access,
   add the resulting GitHub Secrets, and get one real deploy live — promote
   this ADR's Status to Accepted only after that.
2. Decide, separately, whether to migrate AI from Bedrock to Vertex AI's
   hosted Anthropic models now that compute lives on GCP — write its own ADR
   if pursued; do not fold it into this one after the fact.
3. Decide a cutover plan (or explicit "run both indefinitely") for
   Render/Railway once the Cloud Run path is validated with real traffic.
4. Move Cloud SQL to a regional (HA) tier before it is the production
   database of record for real beneficiary PHI at scale (default here is
   single-zone `db-custom-2-8192`).
5. Add a custom domain + WAF (Cloud Armor or an external load balancer) once
   this is meant to be a public-facing beneficiary/agent surface rather than
   the `*.run.app` default.
