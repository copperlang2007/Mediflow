# Mediflow load tests

[k6](https://k6.io) load-test scripts for the Mediflow Medicare CRM API. k6 is
the standard scriptable, CI-friendly load tester; scripts are plain JS and need
no build step.

These scripts target the API server's hot paths:

| Scenario file | Endpoint(s) | Type |
| --- | --- | --- |
| `scenarios/contacts-list.js` | `GET /contacts` | read |
| `scenarios/contact-detail.js` | `GET /contacts/:id` + `/threads` `/messages` `/activities` | read |
| `scenarios/contact-create.js` | `POST /contacts` | write |
| `scenarios/contacts-bulk.js` | `POST /contacts/bulk` | write |
| `scenarios/twilio-webhook.js` | `POST /webhooks/twilio/sms` | webhook |
| `scenarios/commissions.js` | `GET /agents/:id/commissions` | read (heavy) |
| `scenarios/commission-upload.js` | `POST /commissions/statements` + `/parse` + `/reconcile` | write (heavy) |

Plus two combined entry points:

- `smoke.js` — light, CI-able sanity pass (1 VU per scenario, 5 iterations).
- `stress.js` — ramps load up to find the breaking point.

## Install k6

```sh
# macOS
brew install k6
# Debian/Ubuntu
sudo apt-get install k6
# or see https://grafana.com/docs/k6/latest/set-up/install-k6/
```

## Quick start

```sh
k6 run -e BASE_URL=http://localhost:3000 -e API_TOKEN=<jwt> load-tests/smoke.js
```

## Environment variables

| Var | Required | Used by | Notes |
| --- | --- | --- | --- |
| `BASE_URL` | yes | all | API host root **without** `/api` (the API mounts authed routes under `/api` itself). Default `http://localhost:3000`. |
| `API_TOKEN` | yes (except webhook-only runs) | all `/api` scenarios | A valid Clerk **session JWT**. See "Auth" below. |
| `AGENT_ID` | for commissions | `commissions.js`, smoke/stress | An agent id in the target org. |
| `CONTACT_ID` | optional | `contact-detail.js` | Pin the detail read to a known contact. If unset, discovered from `GET /contacts`. |
| `CARRIER_ID` | for commission upload | `commission-upload.js` | A carrier id in the target org. |
| `WEBHOOK_URL` | for webhook | `twilio-webhook.js` | Exact public URL Twilio would POST to. Default `${BASE_URL}/webhooks/twilio/sms`. The HMAC signature is computed over this string, so it must match the URL the server reconstructs. |
| `TWILIO_AUTH_TOKEN` | for webhook | `twilio-webhook.js` | Same token the server validates against. Without it the script can't sign requests and all return 403. |
| `TWILIO_FROM` / `TWILIO_TO` | optional | `twilio-webhook.js` | E.164 phone numbers; default to Twilio test numbers. |
| `ALLOW_WRITES` | optional | `smoke.js`, `stress.js` | Set `true` to include write scenarios (create/bulk). Off by default so CI smoke runs are read-only. |
| `PEAK_VUS` | optional | `stress.js` | Peak virtual users at the top of the ramp. Default `150`. |

## Auth — how the token works

The API authenticates every `/api/*` route with **Clerk**
(`artifacts/api-server/src/app.ts` mounts `clerkMiddleware`;
`middlewares/requireAuth.ts` calls `getAuth(req)`). It accepts the Clerk
session JWT as either an `Authorization: Bearer <jwt>` header or a `__session`
cookie — the scripts send **both** (`load-tests/lib/auth.js`) so they work
regardless of deployment config.

k6 cannot run Clerk's browser sign-in flow, so the JWT must be minted out of
band and passed via `API_TOKEN`. Options:

1. **From a browser session (quickest):** sign in to the web app, open
   DevTools → Application → Cookies, copy the `__session` value. These JWTs
   are short-lived (~1 min by default) — fine for a smoke run, refresh for
   longer runs.
2. **Clerk backend API / testing tokens:** use Clerk's
   [testing tokens](https://clerk.com/docs/testing/overview) or a long-lived
   session created via the Clerk backend SDK against the staging instance.
3. **Staging service user:** provision a dedicated load-test user in the
   staging Clerk instance and script token minting with the Clerk backend API.

The token's user determines org scoping and permissions. For the commission
upload scenario the user must be **MFA-enrolled** with `commission:create`
/`commission:update` (admin/super_admin) — those routes are behind
`requireMfa`.

Some sensitive routes also need step-up (recent-auth) headers; the load
scenarios here avoid those, but `lib/auth.js` exposes `exportHeaders()` if you
extend coverage.

## Pointing at staging

```sh
k6 run \
  -e BASE_URL=https://staging.mediflow.example \
  -e API_TOKEN="$STAGING_JWT" \
  -e AGENT_ID="$STAGING_AGENT_ID" \
  load-tests/stress.js
```

For the webhook against staging:

```sh
k6 run \
  -e WEBHOOK_URL=https://staging.mediflow.example/webhooks/twilio/sms \
  -e TWILIO_AUTH_TOKEN="$STAGING_TWILIO_AUTH_TOKEN" \
  load-tests/scenarios/twilio-webhook.js
```

## Thresholds (SLOs)

Defined centrally in `lib/config.js` and applied to every script:

- Reads: `p95 < 500ms`
- Writes: `p95 < 1s`
- Twilio webhook: `p95 < 2s` (well under Twilio's 10s webhook timeout)
- Overall error rate: `< 1%`

k6 exits non-zero if a threshold is breached, so `smoke.js` is safe as a CI
gate. `stress.js` is *expected* to breach at its peak (that's the breaking
point you're hunting) — run it manually, not as a blocking gate.

## Writes and data safety

`contact-create.js`, `contacts-bulk.js` and `commission-upload.js` **mutate
the database** and enqueue background jobs. Run them only against a
disposable or staging org, never production. Created contacts are tagged
`loadtest` / `loadtest-bulk` so they can be found and cleaned up afterwards.

## Running individual scenarios

Each scenario file is also runnable directly with its own `vus`/`duration`:

```sh
k6 run -e API_TOKEN=<jwt> load-tests/scenarios/contacts-list.js
```

## CI

These scripts are delivered runnable but are **not** wired into CI by this
change. To add a CI smoke gate later, run `k6 run load-tests/smoke.js`
against an ephemeral environment with a freshly-minted token; keep
`ALLOW_WRITES` unset so the gate stays read-only.
