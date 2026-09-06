/**
 * Pre-deploy demo seeding gate.
 *
 * `railway.json` lives at the repo root and is therefore read by EVERY
 * Railway service built from this repository — including the production API
 * documented in `docs/DEPLOY_API_RAILWAY.md`, which runs `NODE_ENV=production`.
 * Running `seed-demo.ts` unconditionally there would either abort the deploy
 * (the seed calls `encryptSsn`, which refuses to run in production without
 * PHI keys) or, with keys present, insert a fixed synthetic organization and
 * users into a real database. Neither is acceptable, so this wrapper runs the
 * seed ONLY when `DEMO_MODE=true`.
 *
 * It also closes the honesty gap in chaining the seed with `&&`. When a
 * concurrent deploy already holds the advisory lock, `seed-demo.ts`
 * deliberately fails open: it logs that the seed is INCOMPLETE and returns
 * successfully so the app can still boot. That is right for a boot path and
 * wrong for a deploy gate — the `&&` chain would report success and promote a
 * deployment whose demo user does not exist, which is the exact
 * green-but-unusable state the seeding change exists to prevent.
 *
 * So after the seed returns, this verifies three things and exits non-zero on
 * any of them, so Railway fails the pre-deploy and keeps serving the previous
 * version instead of promoting a broken one:
 *
 *   1. the demo user exists;
 *   2. it is ACTIVE — requireAuth rejects an inactive demo user with the same
 *      401 as a missing one, and the seed never reactivates an existing row;
 *   3. the seed's completion MARKER is present — `seedUsers()` runs long
 *      before agents, contacts, deals and commissions, so the user being there
 *      does not mean the seed finished.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `@workspace/db` throws at IMPORT time when DATABASE_URL is unset, so it is
// imported dynamically below — after the DEMO_MODE check. A static import
// would make the "not a demo service, skip" path crash on exactly the
// services this gate exists to leave alone.

import { USERS, LAST_COMMISSION_LINE_ID } from "./demo-constants";

/**
 * The seeded default demo principal, taken from the seed's own constants
 * rather than re-typed here. `artifacts/api-server/src/lib/demoMode.ts` holds
 * a third copy as `DEFAULT_DEMO_USER_ID`; the two packages cannot share a
 * module today without api-server depending on @workspace/scripts.
 */
const DEFAULT_DEMO_USER_ID = USERS.superAdmin;

function demoUserId(): string {
  const fromEnv = process.env["DEMO_USER_ID"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DEMO_USER_ID;
}

async function main(): Promise<void> {
  // Mirrors `isDemoMode()` in api-server's `lib/demoMode.ts`: DEMO_MODE=true
  // AND NODE_ENV !== "production". Checking DEMO_MODE alone let the pair
  // through, and the seed then wrote partial rows (org, users, carriers)
  // before encryptSsn threw on the missing PHI keys. `assertProdEnvIntegrity`
  // refuses to boot the app on that pair anyway, so a service in that state is
  // misconfigured — seeding it can only leave orphan demo data behind.
  if (
    process.env["DEMO_MODE"] !== "true" ||
    process.env["NODE_ENV"] === "production"
  ) {
    console.log(
      "[predeploy-seed] not a demo deployment (needs DEMO_MODE=true and " +
        "NODE_ENV != production) — skipping the demo seed.",
    );
    return;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const seed = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(here, "seed-demo.ts")],
    { stdio: "inherit" },
  );
  if (seed.status !== 0) {
    throw new Error(
      `[predeploy-seed] seed-demo.ts exited with status ${seed.status}`,
    );
  }

  // The seed can return 0 without having produced a usable demo (the
  // fail-open lock-timeout path). Verify the thing the app actually needs.
  const [{ db }, { usersTable, commissionLineItemsTable }, { eq }] =
    await Promise.all([
      import("@workspace/db"),
      import("@workspace/db/schema"),
      import("drizzle-orm"),
    ]);
  const id = demoUserId();
  // `isActive` is part of the check, not decoration: requireAuth's demo branch
  // rejects on `!demoUser || !demoUser.isActive` and returns the SAME "Demo
  // user not found" 401 either way. And the seed will not repair it — seedUsers
  // inserts only when the row is absent, so a demo user deactivated through
  // PATCH /users/:userId/active stays deactivated across every future deploy.
  // Verifying existence alone would pass and promote a deployment that 401s on
  // every request, which is the state this gate exists to prevent.
  const rows = await db
    .select({ id: usersTable.id, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);

  const demoUser = rows[0];

  if (!demoUser) {
    throw new Error(
      `[predeploy-seed] demo user ${id} is still missing after seeding. ` +
        "Refusing to promote a deployment that cannot serve an authenticated " +
        "request. If a concurrent deploy held the seed lock, retry this deploy.",
    );
  }

  if (!demoUser.isActive) {
    throw new Error(
      `[predeploy-seed] demo user ${id} exists but is deactivated. ` +
        "requireAuth rejects an inactive demo user, so every request would 401. " +
        "Re-running the seed will NOT fix this — it only inserts a missing row. " +
        "Reactivate the user (PATCH /users/:userId/active) or point DEMO_USER_ID " +
        "at an active seeded user, then redeploy.",
    );
  }

  // The demo user alone is not proof the seed finished. `seedUsers()` runs
  // long before agents, contacts, deals and commissions, so on the fail-open
  // lock-timeout path a peer can have written the org and user and still be
  // going — the user is present, the demo is empty, and checking only the user
  // would green-light exactly the state this gate exists to prevent.
  //
  // LAST_COMMISSION_LINE_ID is the seed's own completion marker: deliberately
  // the last row the last seeder writes. seedAll() uses it for the same
  // question, so the gate and the seed agree on what "complete" means.
  const marker = await db
    .select({ id: commissionLineItemsTable.id })
    .from(commissionLineItemsTable)
    .where(eq(commissionLineItemsTable.id, LAST_COMMISSION_LINE_ID))
    .limit(1);

  if (marker.length === 0) {
    throw new Error(
      "[predeploy-seed] the demo user exists but the seed completion marker " +
        `(${LAST_COMMISSION_LINE_ID}) is missing, so the seed did not finish — ` +
        "the demo would come up with empty deals, contacts and commissions. " +
        "This is the fail-open path taken when a concurrent deploy held the " +
        "seed lock for over 120s. Retry this deploy once the peer finishes.",
    );
  }

  console.log(
    `[predeploy-seed] demo user ${id} active and seed complete — deploy may proceed.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
