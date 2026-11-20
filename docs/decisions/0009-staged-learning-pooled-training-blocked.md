# 9. The product learns in three stages; pooled training on customer data is blocked

- **Status:** Proposed (owner stated this direction on 2026-11-19). Merging this file does not accept it. Acceptance is a separate change that sets this status to Accepted and updates `AGENTS.md` section 2 and the "Decided direction" block in `docs/STATE.md` in the same commit.
- **Date:** 2026-11-20

## Context

The owner wants the product to keep improving and chose, as the end state,
fine-tuning a shared model on de-identified data pooled across agencies. When
agencyBRIDGE is sold to other agencies the owner is a business associate and
carries the liability for how their PHI is used.

## Decision

1. **Stage 1, per-tenant memory and retrieval.** Allowed from version 1.
   Nothing learned from one agency is visible to another.
2. **Stage 2, product-wide tuning without customer content.** Prompts, tool
   definitions and model routing change only when they beat the current version
   on a fixed evaluation set. Evaluation cases are synthetic; a real
   interaction may inspire a case only after a person rewrites it with
   synthetic details throughout (names, dates, identifiers, health details and
   wording), so no customer content enters the shared set.
3. **Stage 3, pooled fine-tuning on de-identified data.** No code may be built
   or run for this until all three exist and the owner confirms in writing:
   - a de-identification method that meets HIPAA (Safe Harbor or expert
     determination) and has been tested on every type of data that would be
     pooled (call transcripts, documents, chat and agent history, and any
     other), with a type excluded until it has passed;
   - an executed BAA (or signed opt-in) that permits it from every agency
     whose data would be pooled; an agency that has not agreed is excluded;
   - written sign-off from a HIPAA attorney.

## Consequences

- "Constantly improving" in version 1 means stages 1 and 2.
- No attorney is engaged as of 2026-11-20. Engaging one is an owner task.
- Any PR that trains a model on customer content, pools it across agencies, or
  moves it into a shared learning or evaluation set before stage 3 is
  unblocked is a defect. Stage 1 per-tenant memory and ordinary exports an
  agency makes of its own data (for example the existing audited CSV export)
  are not affected.
