# GCP Identity Platform authentication migration

Status: Proposed. Production still uses Clerk. No PHI launch until the BAA and end-to-end auth gates pass.

## Decision

Use Google Cloud Identity Platform in the existing `agencyportal-501523` GCP project with email/password and TOTP MFA. Do not use SMS, SAML, or OIDC for the initial release. Tier-1 authentication currently includes 50,000 monthly active users at $0; usage beyond that tier can incur charges. GCP hosting, database, email delivery, and other resources still cost money. Pricing: https://cloud.google.com/identity-platform/pricing

Google's Identity Platform HIPAA guide requires a signed Google BAA when using Google services with PHI: https://cloud.google.com/security/compliance/hipaa/identity-platform

## Existing coupling found in repository

- Web: `artifacts/web-app/src/App.tsx` owns ClerkProvider, sign-in/up, route guards, token retrieval and query invalidation. Additional hooks/components use Clerk user objects and token methods.
- API: `artifacts/api-server/src/app.ts` mounts Clerk middleware/proxy; `middlewares/requireAuth.ts` maps Clerk user ID to `users.id`, checks session timeout and MFA; `routes/auth.ts` provisions users; invitations and admin call Clerk.
- Deploy: `.github/workflows/deploy-mediflow-gcp.yml` and `scripts/deploy/gcp-deploy.sh` require Clerk keys. Production has a Clerk development-mode key. Switching only the sign-in screen would strand all existing accounts.

## Migration implementation

1. Create Identity Platform config under the existing GCP project; enable email/password, email verification, enumeration protection and TOTP MFA; restrict authorized domains to production and development hosts. Keep PHI and profile fields out of identity claims.
2. Implement one auth adapter consumed by web hooks, route guards, invite flow, and API fetch token attachment. Add sign-in, invite-only sign-up, email verification, password reset, and TOTP enrollment/challenge screens.
3. Verify ID tokens server-side with Firebase Admin SDK, including issuer/audience/project, expiration, revocation strategy and verified email. Derive user ID and email only from verified tokens. Reject unverified emails before account provisioning. Preserve tenant and role authorization in PostgreSQL.
4. Add a mapping from `(provider, subject)` to existing `users.id`; never replace current `users.id` or match a new identity to an agency merely because client-submitted email matches. Migrate each existing user through a verified, one-time account-link workflow. Block duplicate emails and cross-tenant attachment.
5. Map Identity Platform `firebase.sign_in_second_factor` / verified MFA state to `mfaEnrolled`; enforce recent authentication for step-up operations and server-side inactivity timeout. Recheck privileged view-as-agency and admin actions.
6. Replace Clerk account-management calls in admin/invitations, remove Clerk proxy, CSP domains and secret requirements only after migrated accounts can sign in. Retain a rollback to the last working production revision until adoption is confirmed.
7. Verify user journeys in a non-PHI environment: sign-in, password reset, email verification, TOTP enrollment and challenge, invited user, existing-user linking, unauthorized API call, inactive user, tenant isolation, session timeout, privileged actions and sign-out. Run the browser smoke on the production revision after rollout.

## Release gate

- Confirm signed Google Cloud BAA and whether Identity Platform is covered for this GCP organization and project.
- Restore GCP CLI access to configure the service; the currently selected `lang@theartificialbridge.com` gcloud account fails token refresh in noninteractive execution.
- Review existing Clerk user export and count without printing user emails or PHI in logs; choose account-link handoff and rollout window.
- Configure cost alert for Identity Platform usage above the free tier. Do not claim an unlimited free service.
- Complete implementation and full tests before changing the production auth mode. Do not turn on the demo bypass in production.
