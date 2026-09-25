// Auth helpers for k6 scripts.
//
// The agencyBRIDGE API authenticates every `/api/*` route with Clerk
// (artifacts/api-server/src/app.ts mounts `clerkMiddleware`, and
// `requireAuth` calls `getAuth(req)`). Clerk verifies a session JWT that
// normally rides in either:
//   - the `Authorization: Bearer <jwt>` header, or
//   - the `__session` cookie.
//
// k6 cannot perform an interactive Clerk sign-in, so the JWT must be minted
// out of band (see load-tests/README.md) and passed via the API_TOKEN env
// var. These helpers turn that token into request headers and fail fast with
// a clear message if it is missing.

import { API_TOKEN } from './config.js';

// True when an auth token is available. Scripts use this to skip
// gracefully (smoke) or abort loudly (everything else).
export function hasToken() {
  return API_TOKEN.length > 0;
}

// Throws with an actionable message if no token was supplied. Call this in
// a script's `setup()` so the whole run aborts early instead of every VU
// hammering the API with 401s.
export function requireToken() {
  if (!hasToken()) {
    throw new Error(
      'API_TOKEN is not set. The agencyBRIDGE API requires a Clerk session JWT. ' +
        'Mint one (see load-tests/README.md) and pass it with ' +
        '`-e API_TOKEN=<jwt>`.',
    );
  }
}

// Standard JSON headers for an authenticated API request.
export function authHeaders(extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      // Belt-and-suspenders: also send the cookie form so the script works
      // regardless of how the target deployment is configured to read the
      // Clerk session.
      Cookie: `__session=${API_TOKEN}`,
    },
    extra || {},
  );
}

// Headers for a step-up-protected route. Several sensitive endpoints
// (PHI export, destructive ops) additionally require recent-auth + a
// confirmation header — see requireExportConfirm / requireDestructiveConfirm.
export function exportHeaders() {
  return authHeaders({ 'X-Confirm-Export': 'true' });
}
