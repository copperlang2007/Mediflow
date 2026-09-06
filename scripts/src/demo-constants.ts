/**
 * Identity and completion constants for the demo seed.
 *
 * Extracted so `predeploy-seed.ts` can verify what `seed-demo.ts` writes
 * without importing `seed-demo.ts` itself — that module calls `main()` at
 * module scope, so importing it would RUN the seed as a side effect.
 *
 * This file must stay side-effect free for that reason: no `main()`, no
 * database access, no environment reads. Constants only.
 *
 * `DEMO_SUPER_ADMIN_ID` is also duplicated as `DEFAULT_DEMO_USER_ID` in
 * `artifacts/api-server/src/lib/demoMode.ts`. The two cannot share a module
 * today without the api-server package depending on `@workspace/scripts` or a
 * new shared package existing; the values are pinned to each other by the
 * comment in each file, and `predeploy-seed.ts` fails the deploy loudly if
 * they ever drift, because the user it looks for would not be found.
 */
import { createHash } from "node:crypto";

/** The seeded demo organization. */
export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001";

/** Seeded users. `superAdmin` is the default demo principal. */
export const USERS = {
  superAdmin: "00000000-0000-4000-8000-000000000010",
  agencyAdmin: "00000000-0000-4000-8000-000000000011",
  carlosUser: "00000000-0000-4000-8000-000000000012",
  lindaUser: "00000000-0000-4000-8000-000000000013",
} as const;

/**
 * The role each seeded user is created with.
 *
 * `predeploy-seed.ts` verifies the demo principal still holds its seeded role:
 * `requireAuth`'s demo branch reads `demoUser.role` straight from the database,
 * and `PATCH /users/:userId/role` is gated on super_admin — so the default demo
 * principal can demote ITSELF and then lack the permission to undo it.
 */
export const USER_ROLES = {
  [USERS.superAdmin]: "super_admin",
  [USERS.agencyAdmin]: "agency_admin",
  [USERS.carlosUser]: "agent",
  [USERS.lindaUser]: "agent",
} as const satisfies Record<string, "super_admin" | "agency_admin" | "agent">;

/**
 * Build child IDs from a stable prefix so reseeds with the same input land on
 * the same UUID-shaped strings (idempotency without table-by-table "upsert"
 * plumbing). We're not picky about UUID validity here — the columns are plain
 * `text`, and the prefix makes ownership obvious in a DB browser.
 */
export function stableId(scope: string, key: string): string {
  const h = createHash("sha1").update(`${DEMO_ORG_ID}:${scope}:${key}`).digest("hex");
  return `demo-${scope}-${h.slice(0, 16)}`;
}

export const COMMISSION_STATEMENT_SLUGS = ["aetna-2025-04", "humana-2025-04"] as const;
export const COMMISSION_LINES_PER_STATEMENT = 4;

/**
 * The seed's completion marker: the LAST row the LAST seeder writes.
 *
 * `seedAll()` checks this to decide whether a previous run finished, and
 * `predeploy-seed.ts` checks it to distinguish "the demo user exists because
 * the seed completed" from "the demo user exists because a peer wrote it
 * early and is still going" — `seedUsers()` runs long before agents,
 * contacts, deals and commissions.
 */
export const LAST_COMMISSION_LINE_ID = stableId(
  "line",
  `${stableId("stmt", COMMISSION_STATEMENT_SLUGS[COMMISSION_STATEMENT_SLUGS.length - 1]!)}-${COMMISSION_LINES_PER_STATEMENT - 1}`,
);
