# EnrollHere → agencyBRIDGE webhook

> **Compliance prerequisite:** these payloads carry PHI (names, DOB, Medicare
> ID). Confirm a signed Business Associate Agreement (BAA) with EnrollHere
> covering this data flow before enabling the webhook for an agency.

Every call EnrollHere reports creates or updates the caller's contact and adds a
**Call Log** entry to their timeline.

## Endpoint

```
POST https://<your-agencyBRIDGE-host>/api/integrations/enrollhere/v1/<orgId>/events
Content-Type: application/json
```

`<orgId>` is the agency's organization id in agencyBRIDGE.

## Authentication (pick one)

The shared secret is `ENROLLHERE_WEBHOOK_SECRET` (or a per-agency
`ENROLLHERE_WEBHOOK_SECRET_<ORGID>`). Generate one with `openssl rand -hex 32`.

1. **Signed (preferred):** `X-MB-Signature: t=<unix seconds>,v1=<hex>` where
   `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Rejected if older than 5 minutes.
2. **Static header:** `X-Webhook-Secret: <secret>` or `Authorization: Bearer <secret>`.
   This has **no replay window** (a captured request stays valid until the
   secret changes), so prefer option 1 whenever the sender can sign; if the
   static header is used, rotate the secret periodically.

Secrets in the URL/query string are deliberately not accepted (they end up in logs).
With no secret configured, every request is rejected.

## Payload

EnrollHere has not published a webhook schema, so fields are matched by name.
The person can be top-level or nested under `contact`, `lead`, `client`,
`customer`, or `data.contact`; `snake_case` and `camelCase` both work.

| Purpose | Recognized field names (examples) |
|---|---|
| Name (required) | `first_name`/`firstName`, `last_name`/`lastName`, or `name` / `full_name` |
| Contact | `email`, `phone` / `phone_number` (falls back to `caller_id`, `from`, `ani`) |
| Profile | `dob` / `date_of_birth`, `address1` / `address`, `city`, `county`, `state`, `zip`, `medicare_id` / `mbi` |
| Agent | `agent_email`, `user_email`, `rep_email` |
| Call id (dedupe) | `call_id`, `call_uuid`, `call_sid`, `event_id` (else a hash of the body without delivery fields; a bare `id` is not used, since it is often the person's id) |
| Call details | `direction`, `duration` (seconds or `mm:ss`), `disposition` / `outcome`, `recording_url`, `started_at` |

The contact is matched with the same rules as the CSV import (Medicare ID,
then email/phone **plus first name**, then name + date of birth) and only blank
fields are filled on an existing contact. Medicare IDs are stored encrypted.

## Responses

| Status | Meaning |
|---|---|
| 200 `{ duplicate: false, contactId, contactCreated, activityId }` | Logged |
| 200 `{ duplicate: true }` | Same call id already received — nothing done |
| 401 / 403 | Bad, missing, or stale credential |
| 503 | Webhook secret not configured on our side yet — retry later |
| 404 | Unknown org id |
| 422 `{ fieldsReceived }` | No contact name in the payload — lists the field names that did arrive |
| 500 | Temporary failure — safe to retry |

Payload values are never stored beyond the contact and call log; the
`integration_events` table records only the field **names** seen, so an
unmapped EnrollHere field can be spotted and added.

## Deploy

- **GCP:** set the GitHub secret `ENROLLHERE_WEBHOOK_SECRET` (the GCP deploy also accepts `ENROLLHERE_WEBHOOK_PASSWORD`). Re-run
  `scripts/deploy/gcp-bootstrap.sh` once so the `mediflow-enrollhere-webhook-secret`
  Secret Manager placeholder exists; the deploy workflow then syncs and mounts it.
- **Render:** set `ENROLLHERE_WEBHOOK_SECRET` in the service's environment.

## Policy events (`PE_POLICY_CREATED`, `PE_POLICY_UPDATED`, …)

Mapped from a real delivery (see `artifacts/api-server/src/__tests__/fixtures/enrollhere-policy-created.json`, fake values).

| agencyBRIDGE | EnrollHere field |
|---|---|
| Contact name, email, phone | `policy.enrollment.consumer` (fallback `policy.lead`) |
| Address | `consumer.address.line1/city/state/zip/county` |
| Date of birth | `consumer.birthDate.date` |
| Medicare ID (encrypted) | `consumer.medicare.number` / `enrollment.medicareInfo.number` |
| Assigned agent | `policy.agent.email` |
| Enrollment: carrier, plan, plan type, SNP | `enrollment.carrier.name`, `enrollment.plan.id/name/planType/snp` |
| Effective / signature date | `enrollment.details.effectiveDate` / `signatureDate` |
| Status | `policy.manualStatus` → `automaticStatus` → `details.policyStatus` (`POL_INFORCE` = active + effectuated) |
| Policy number | `policy.identifiers.bySource.policyId.ids[0]` |
| Application key | Sunfire code `identifiers.bySource.sunfire.ids[0]`, else `policy:<policy.id>` |

The full payload (minus a relay's `headers` wrapper) is stored encrypted and versioned in `enrollment_application_versions`; an identical redelivery adds no version. Health answers (`medicareInfo.chf/copd/cvd/diabetes/…`) and any race/ethnicity fields are **never** promoted to plain columns and never feed routing, scoring or AI. They are visible only in the contact's **Applications → Full application** view, which is limited to super admins, agency admins and compliance managers, and writes an `audit_log` entry (`view_full_application`) before any data is returned.

Today EnrollHere delivers these to a GoHighLevel workflow. To send them here as well, add this endpoint as a second webhook in EnrollHere, with the `X-Webhook-Secret` header.
