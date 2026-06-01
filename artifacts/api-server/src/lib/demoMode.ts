/**
 * Demo mode — no-auth walkthrough support.
 *
 * When `DEMO_MODE=true`, the API skips Clerk authentication entirely and
 * resolves every request to a single seeded demo user (see `requireAuth`).
 * This exists so a design-partner can be shown the real product over a
 * shareable URL without provisioning Clerk identities.
 *
 * SECURITY — this is deliberately hard to enable by accident:
 *   - It is a NO-OP whenever `NODE_ENV === "production"`. The auth bypass
 *     can never activate in a production deploy, regardless of the flag.
 *   - `assertProdEnvIntegrity` (prodEnvGuard) refuses to boot if `DEMO_MODE`
 *     is paired with `NODE_ENV=production` or with real (live Clerk / PHI)
 *     credentials, so a demo build can never sit in front of real PHI.
 *
 * The demo user defaults to the seeded INSUREitALL agency admin
 * (`scripts/seed-demo.ts`); override with `DEMO_USER_ID` if the seed changes.
 */

// Seeded INSUREitALL "agency_admin" (marcus@insureitall.example) — the
// natural agency-owner persona for a walkthrough. Mirrors the fixed UUID in
// scripts/src/seed-demo.ts.
export const DEFAULT_DEMO_USER_ID = "00000000-0000-4000-8000-000000000011";

/**
 * True only when demo mode is explicitly enabled AND this is not a
 * production NODE_ENV. The production check is intentionally non-overridable.
 */
export function isDemoMode(): boolean {
  return process.env["DEMO_MODE"] === "true" && process.env["NODE_ENV"] !== "production";
}

/** The seeded user id every demo request is resolved as. */
export function demoUserId(): string {
  const fromEnv = process.env["DEMO_USER_ID"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DEMO_USER_ID;
}
