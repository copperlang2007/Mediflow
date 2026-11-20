# 8. Open-weight models on Amazon Bedrock, behind one model gateway

- **Status:** Proposed (owner decision 2026-11-20; becomes Accepted when the owner merges this)
- **Date:** 2026-11-20

## Context

The decided direction says Claude on Bedrock is the AI provider, called through
the Anthropic Messages API (ADR 0005). The owner now wants to sell agencyBRIDGE
as an AI workspace at $75 to $100 per user per month with idle cost near zero,
and has chosen open-weight models on Bedrock, paid per use, as the default.

Open-weight models on Bedrock do not use the Anthropic Messages API. The four
existing AI call sites cannot reach them.

## Decision

1. Add a model gateway: one internal interface for every AI call. Behind it,
   two adapters: the existing Anthropic Messages adapter and a new one for
   Bedrock's open-weight models.
2. Open-weight models are the default for new workspace features. Which model
   serves which job is decided by the evaluation set in
   `docs/product/DESIGN.md`, not by preference.
3. A model may receive PHI in production only if it is on an allow-list in
   code. A model goes on the list only after AWS confirms it is covered by the
   BAA. The existing production boot guard is extended to enforce the list; it
   is not weakened.
4. Existing Claude call sites keep working. Each is moved to an open model only
   after that job's evaluations pass. Where none passes, the owner decides.

## Consequences

- ADR 0005 stays true for Claude and no longer describes every AI call.
- `AGENTS.md` section 2 and `docs/STATE.md` "Decided direction" must be updated
  when this is accepted.
- Until AWS confirms eligibility per model, open models see synthetic data only.
- Hosting on AWS + Neon instead of Google Cloud is a separate decision that
  still needs its own ADR from the go-live work.
