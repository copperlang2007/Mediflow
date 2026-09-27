# 6. Scope of Appointment is captured on the call recording

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

INSUREitALL's sales calls are inbound MA calls on the INSUREitALL dialer. The
Scope of Appointment is obtained verbally at the start of the call and lives on
the call recording. There is no separate signed SOA form, and INSUREitALL does
not operate under a 48-hour wait between SOA and the sales discussion.

This may change (for example, if outbound or field appointments are added), so
the rule is recorded here rather than assumed.

## Decision

- agencyBRIDGE does **not** enforce a 48-hour (or any) wait between SOA and a
  sales call, and does not require an SOA document before a call is routed or
  precleared. `preclearance.ts` reports `soaRequired` / `soaOnFile` as
  information only; neither is part of `precleared`.
- The SOA control is detective, not preventive: the transcript parse
  (`lib/dialer/transcriptParse.ts`) records `scopeOfAppointment.required` /
  `captured` / `products` for every call, and a sales call with no scope
  captured raises a compliance oversight task (`lib/dialer/handlers.ts`,
  `lib/dialer/oversight.ts`).
- Evidence of an SOA is the call recording plus its parsed
  `scopeOfAppointment`, not an uploaded form.

## Consequences

- An enrollment's SOA evidence is the call it came from. Linking each
  enrollment to that call (and its `captured` result) is what makes SOA
  auditable per enrollment; that link is a follow-up.
- If INSUREitALL adds appointment types where a signed SOA or a waiting period
  applies, this decision must be revisited before any gate is added, and the gate
  should be scoped to those appointment types only.
