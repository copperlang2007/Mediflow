# Hardening Phase 0 — Implementation

> **Status: PLACEHOLDER — not a specification.**
>
> This file has never contained more than a single sentence of intent. It is
> kept because it is referenced elsewhere, but it does not describe implemented
> work and must not be cited as evidence that any of the below exists.

## Original intent (unimplemented)

> Full Phase 0 hardening code and architecture for RIE + EGE + MediFlow +
> Bridget system. Includes failover layer, self-healing, audit simulator, and
> solo-founder weekly ritual updates.

None of the four named components — failover layer, self-healing, audit
simulator, weekly ritual automation — exists in this repository.

## What hardening *does* exist, and where to verify it

These are implemented and can be read in the code today. They are unrelated to
the Phase 0 plan above; they were built separately.

| Control | Location |
|---|---|
| AES-256-GCM Medicare ID encryption + HMAC blind index | `lib/db/src/encryption/medicareId.ts` |
| Plaintext-drop migration with in-migration safety guard | `lib/db/migrations/` |
| Audit-log immutability enforced by DB triggers | `lib/db/migrations/` |
| DB-backed idle session timeout | `artifacts/api-server/src/middlewares/requireAuth.ts` |
| Step-up re-auth before PHI bulk export | `artifacts/api-server/src/middlewares/requireAuth.ts` |
| RBAC matrix (7 roles × 26 resources × 5 actions) | `artifacts/api-server/src/lib/permissions.ts` |
| Tenant-isolation static guard | `artifacts/api-server/src/__tests__/guards/tenant-isolation.test.ts` |
| Non-HIPAA AI provider boot guard | `artifacts/api-server/src/lib/prodEnvGuard.ts` |
| Sentry PHI scrubber | `artifacts/api-server/src/lib/sentryPhiScrubber.ts` |

## Next action

Either write the Phase 0 spec this file's title promises, or delete the file
and reference the table above directly. Leaving a one-line stub that looks like
a specification is the failure mode this notice exists to prevent.
