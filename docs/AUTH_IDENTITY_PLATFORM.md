# Sign-in with Google Cloud Identity Platform (replaces Clerk)

Decision: [ADR 0006](decisions/0006-gcp-identity-platform-auth.md). This page
is the setup and cutover checklist. The code is in the repo; production
switches over only when step 4 is done, because the deploy waits for the
`IDENTITY_PLATFORM_API_KEY` GitHub secret.

## What people will see

- **Sign in:** email and password, then a 6-digit code from an authenticator
  app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).
- **First time after the switch:** everyone (including you) clicks **Create
  your login** on the sign-in page and uses the **same email address** as
  before. After clicking the link in the verification email, their agency,
  role and history come back automatically. Then they set up the
  authenticator app once and sign in again.
- **New people:** invitations work as before: open the invitation link,
  create a login, verify the email, accept.
- Forgot password: a reset link by email. Sessions still end after the
  agency's idle timeout.

## One-time setup (owner, in Google Cloud: project `GCP_PROJECT_ID`)

1. **Re-run `scripts/deploy/gcp-bootstrap.sh`.** It now also turns on the
   Identity Platform API and lets the app's service account cancel a user's
   sign-ins when an admin uses Force logout (role *Firebase Authentication
   Admin*).
2. **Turn on Identity Platform** (Console → Identity Platform → Enable). Then:
   - **Providers → Add a provider → Email / Password.** Enable it with
     password sign-in (not "passwordless").
   - **Settings → Security:** turn on *email enumeration protection*; set a
     password policy of at least 12 characters (the app asks for 12).
   - **Settings → Authorized domains:** add the production address(es)
     people use (custom domain and the `*.run.app` address). Keep `localhost`
     only if you develop locally.
   - **Templates:** set the sender name to *agencyBRIDGE* for the
     verification and password-reset emails.
3. **Turn on authenticator-app (TOTP) two-step.** The console does not show
   this switch yet; run once (Cloud Shell, signed in as an owner):

   ```bash
   PROJECT=<GCP_PROJECT_ID>
   curl -sS -X PATCH \
     "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=mfa" \
     -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     -H "X-Goog-User-Project: ${PROJECT}" -H "Content-Type: application/json" \
     -d '{"mfa":{"providerConfigs":[{"state":"ENABLED","totpProviderConfig":{"adjacentIntervals":5}}]}}'
   ```

4. **Give the deploy the browser key.** Console → APIs & Services →
   Credentials: use the key Identity Platform created (or create one),
   restrict it to the *Identity Toolkit API* and to your production website
   address(es). Add it as the GitHub Actions secret
   **`IDENTITY_PLATFORM_API_KEY`**. (It is public by design: it only names the
   project to the browser. It is a secret so the deploy waits for it.)
   Optional secret `IDENTITY_PLATFORM_AUTH_DOMAIN`; default
   `<GCP_PROJECT_ID>.firebaseapp.com`.
5. **Cost alert** (ADR 0006): Identity Platform is free up to 50,000 monthly
   active users on email/password; add a budget alert on the project anyway.
6. **BAA:** confirm Identity Platform is covered by the Google Cloud BAA for
   this project (Google lists it as a HIPAA-covered service).

The next push to `main` (or a manual run of the deploy workflow) then
deploys. The server refuses to start without the project setting, so a
half-configured revision never replaces the working one.

## After the switch

- Sign in yourself first (Create your login → verify → authenticator → sign
  in again) and check the dashboard.
- Tell the team the steps under *What people will see*.
- **Remove Clerk:** delete the GitHub secrets `CLERK_SECRET_KEY` and
  `CLERK_PUBLISHABLE_KEY`, the Secret Manager secrets
  `mediflow-clerk-secret-key` and `mediflow-clerk-publishable-key`, and cancel
  the Clerk plan.

**Rollback:** in Cloud Run, send traffic back to the last revision deployed
before the switch (it still has Clerk). The only database change (table
`user_identities`, migration 0074) is additive and does not affect it.

## How it works (for developers)

- Browser: `@firebase/auth` (`artifacts/web-app/src/lib/auth/`). The ID token
  goes to the API as `Authorization: Bearer` and in the `__session` cookie
  (downloads, live streams), refreshed before it expires.
- API: `lib/auth/identity.ts` verifies the token against Google's keys,
  issuer and audience (`IDENTITY_PLATFORM_PROJECT_ID`, set by the deploy).
  `lib/auth/users.ts` maps the sign-in to a user: `user_identities` link →
  user with that id → one-time link of a Clerk-era account by **verified**
  email (never an unverified one, never when two accounts share the email).
- MFA: the token says whether this sign-in used the authenticator
  (`firebase.sign_in_second_factor`); `requireAuth` refuses otherwise.
- Sessions: a session is one sign-in (`<subject>:<sign-in time>`), tracked in
  `session_activity` for the idle timeout and admin revoke / force-logout.
