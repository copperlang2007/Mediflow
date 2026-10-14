# E2E (Playwright) — opt-in smoke tests

This directory contains a small set of Playwright browser tests that exercise
the web app end-to-end against a real, running dev server.

## Why opt-in?

These tests need real infrastructure:

- a real `DATABASE_URL` (Postgres),
- Identity Platform sign-in configured (`VITE_FIREBASE_*` on the web build,
  `IDENTITY_PLATFORM_PROJECT_ID` on the API),
- a running web dev server (and the API server it talks to),
- a test login with two-step verification set up (`E2E_TEST_EMAIL` /
  `E2E_TEST_PASSWORD` / `E2E_TEST_TOTP_SECRET`).

CI doesn't have any of that, so every test in this folder is wrapped with:

```ts
test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");
```

If you don't set `E2E_ENABLED=true`, the entire suite is inert. They are
**not** included in `pnpm test` (which runs the unit/integration vitest
suite); they are a separate runner under `pnpm e2e`.

## Quick start

```bash
# 1. one-time: install the chromium browser binary
pnpm e2e:install

# 2. terminal A: run the dev server (with DATABASE_URL + Identity Platform configured)
pnpm dev

# 3. terminal B: run the e2e suite
E2E_ENABLED=true \
E2E_BASE_URL=http://localhost:5173 \
E2E_TEST_EMAIL=you+e2e@example.com \
E2E_TEST_PASSWORD='<test login password>' \
E2E_TEST_TOTP_SECRET='<authenticator key shown at setup>' \
pnpm e2e
```

Useful variants:

```bash
# UI mode (great for debugging)
E2E_ENABLED=true pnpm e2e:ui

# Run a single spec
E2E_ENABLED=true pnpm e2e e2e/contacts-list.test.ts
```

## Environment variables

| Variable             | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `E2E_ENABLED`        | Master switch. Anything truthy enables the suite.        |
| `E2E_BASE_URL`       | Base URL of the running dev server. Default `:5173`.     |
| `E2E_TEST_EMAIL`     | Test login email.                                        |
| `E2E_TEST_PASSWORD`  | Test login password.                                     |
| `E2E_TEST_TOTP_SECRET` | Base32 authenticator key of the test login (shown when two-step verification was set up); the helper computes the 6-digit code. |

## What's covered

| Spec                                       | Flow                                          |
| ------------------------------------------ | --------------------------------------------- |
| `auth-and-dashboard.test.ts`               | Sign in, land on dashboard.                   |
| `contacts-list.test.ts`                    | Open `/crm`, contacts table renders.          |
| `document-upload.test.ts`                  | Upload a small PDF, see it in the list.       |
| `automation-rule-create.test.ts`           | Create a `lead_created` rule via the dialog.  |
| `commission-statement-upload.test.ts`      | Upload a CSV statement (Humana).              |

## Caveats

- These tests assume an empty DB. Several flows have `TODO` comments for cases
  where seed data would make the assertions stronger.
- Sign-in goes through the app's own sign-in page (`e2e/_helpers/auth.ts`):
  email, password, then a code computed from `E2E_TEST_TOTP_SECRET`.
