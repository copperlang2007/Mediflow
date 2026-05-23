# Demo seed script

Populates a dev DB with a believable Medicare agency mid-onboarding so the
CRM, contracting UI, and commissions UI all have something to look at.

## Run

```bash
# default — safe to re-run; skips if the demo org already exists
pnpm seed:demo

# wipe + reseed
pnpm seed:demo -- --reset

# quiet (suppress info logs)
pnpm seed:demo -- --quiet
```

`DATABASE_URL` must be set; the script connects via the same Postgres pool
the API uses. `PHI_ENCRYPTION_KEY` / `PHI_HMAC_KEY` are optional in dev
(deterministic dev keys are used when unset).

## What gets created

All rows live under the org **INSUREitALL Demo** with a fixed UUID
(`00000000-0000-4000-8000-000000000001`) so re-runs are stable.

| Area | Rows |
| --- | --- |
| Organizations | 1 — INSUREitALL Demo |
| Users | 4 — Sarah Stevens (super_admin), Marcus Lee (agency_admin), Carlos Reyes (agent), Linda Park (agent) |
| Agents | 2 — Carlos (CA, TX, FL, NY licenses, NPN 20451817), Linda (FL only, NPN 21339042) |
| Carriers | 11 — the production default list, each with a sandbox `appointments@*.example` desk email + cc/subject metadata |
| Carlos onboarding | status=`complete`; one `carrier_contracting_request` per carrier in status=`appointed` with a writing number |
| Linda onboarding | status=`signing`; 4 selected carriers (Aetna/CVS, Humana, UnitedHealth/AARP, Devoted), 1 in status=`signed`, 3 in `paperwork_generated` — the LIVE walkthrough example |
| Agent contracting profiles | 2 — Carlos + Linda, both with SSNs encrypted via the production `encryptSsn` helper. SSNs use the SSA-reserved 999-XX-XXXX prefix so they're obviously fake |
| Contacts | 30 — realistic-but-fake Medicare leads, mix of MA/MAPD/PDP/supp plan types and lead/prospect/enrolled/retained statuses, assigned across Carlos + Linda |
| Pipeline | 1 ("Medicare AEP 2025") with 4 stages |
| Deals | 8 across the pipeline so the dashboard isn't empty |
| Activities | 6 (call_log / note / email mix) for the recent-activity feed |
| Tasks | 3 open tasks across Carlos + Marcus |
| Commission statements | 2 — Aetna April + Humana April with 4 line items each, all crediting Carlos |

## Reset

`--reset` wipes every row under the demo org (in FK-safe order) before
reseeding. The script does **not** touch other orgs.

## Idempotency

Every insert is gated on a `SELECT id` lookup. Re-running with no flags is a
no-op once the org exists. Re-running with `--reset` produces byte-identical
rows (stable IDs derived from `sha1(orgId:scope:key)`).

## Defense in depth

- SSNs go through `encryptSsn()` from `@workspace/db`, so the encrypted
  bytea columns and HMAC blind index are actually exercised. The plaintext
  values are deliberately in the SSA test range (`999-XX-XXXX`).
- Carrier desk emails use the IANA-reserved `.example` TLD — they will
  never deliver to a real address, even if the email-out worker is
  pointed at a real SMTP server.
- The script delegates to `seedDefaultCarriers()` from `@workspace/api-server`
  for the carrier list, so the demo never drifts from production seed
  behavior when a new carrier is added.
