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
 * So after the seed returns, this checks three things before letting the
 * deploy proceed. Two of them exit non-zero, so Railway fails the pre-deploy
 * and keeps serving the previous version instead of promoting a broken one;
 * the middle one is repaired in place, for the reason given below:
 *
 *   1. the demo user exists;
 *   2. the seed's completion MARKER is present — `seedUsers()` runs long
 *      before agents, contacts, deals and commissions, so the user being there
 *      does not mean the seed finished;
 *   3. it is ACTIVE, and still holds its SEEDED ROLE — requireAuth rejects an
 *      inactive demo user with the same 401 as a missing one, and resolves
 *      whatever role the row carries for every demo request. Both are REPAIRED
 *      rather than refused: the seed cannot fix either, so refusing would wedge
 *      every future deploy on one operator action.
 *
 * The two read-only checks come first so a gate that is going to fail never
 * mutates anything — the repair writes an immutable audit row, and one
 * attached to a rejected deploy cannot be removed afterwards.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `@workspace/db` throws at IMPORT time when DATABASE_URL is unset, so it is
// imported dynamically below — after the DEMO_MODE check. A static import
// would make the "not a demo service, skip" path crash on exactly the
// services this gate exists to leave alone.

import { USERS, USER_ROLES, LAST_COMMISSION_LINE_ID } from "./demo-constants";
import { DEFAULT_DEMO_USER_ID as API_DEFAULT_DEMO_USER_ID } from "@workspace/api-server/lib/demoMode";

/**
 * The seeded default demo principal, taken from the seed's own constants
 * rather than re-typed here. `artifacts/api-server/src/lib/demoMode.ts` holds
 * a second definition as `DEFAULT_DEMO_USER_ID`; the two packages cannot share
 * a module today without api-server depending on @workspace/scripts.
 */
const DEFAULT_DEMO_USER_ID = USERS.superAdmin;

/**
 * Assert the two definitions still agree, in BOTH directions.
 *
 * An earlier comment here claimed drift "fails the deploy loudly". That was
 * only half true: this file reads the seed's constant, so editing
 * demo-constants.ts is caught, but editing demoMode.ts alone is not — the gate
 * would verify the id the seed wrote, pass, and the rebuilt api-server would
 * then resolve a different id in requireAuth's demo branch and 401 every
 * request. /api/readyz would not catch it either: it probes the database and
 * the worker pool, not auth resolution.
 *
 * Comparing them here makes the claim true rather than rewording it down.
 */
function assertDemoUserIdConstantsAgree(): void {
  if (API_DEFAULT_DEMO_USER_ID === USERS.superAdmin) return;
  throw new Error(
    "[predeploy-seed] the two demo-principal constants have drifted: " +
      `demoMode.ts DEFAULT_DEMO_USER_ID is ${API_DEFAULT_DEMO_USER_ID} but the ` +
      `seed's USERS.superAdmin is ${USERS.superAdmin}. requireAuth resolves the ` +
      "former and the seed writes the latter, so the api-server would 401 every " +
      "request. Make them match before deploying.",
  );
}

function demoUserId(): string {
  const fromEnv = process.env["DEMO_USER_ID"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DEMO_USER_ID;
}

/**
 * Reject a DEMO_USER_ID the seed can never create, BEFORE running the seed.
 *
 * `demoMode.ts` advertises DEMO_USER_ID as a supported persona override, so
 * operators are expected to set it — and `seedUsers()` only ever inserts the
 * four fixed ids in USERS. Any other value is unreachable: the seed will not
 * create it, and on an already-seeded database seedAll() skips seeding
 * entirely, so retrying cannot help.
 *
 * Checked up front so a typo costs one clear message instead of a full seed
 * run followed by "demo user … is still missing after seeding", which names
 * the symptom rather than the cause.
 */
function assertDemoUserIdIsSeedable(): void {
  const id = demoUserId();
  const seeded = Object.values(USERS) as string[];
  if (seeded.includes(id)) return;
  throw new Error(
    `[predeploy-seed] DEMO_USER_ID is set to ${id}, which the demo seed never ` +
      "creates. seedUsers() inserts only the fixed personas: " +
      `${seeded.join(", ")}. Pick one of those or unset DEMO_USER_ID to use ` +
      "the default super_admin. Re-running the deploy will not fix this.",
  );
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

  // Before the seed, not after: neither of these is recoverable by seeding,
  // so there is no point spending two minutes discovering them downstream.
  assertDemoUserIdConstantsAgree();
  assertDemoUserIdIsSeedable();

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
  const [
    { db },
    { usersTable, commissionLineItemsTable, auditLogTable },
    { eq, and },
  ] = await Promise.all([
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
    .select({
      id: usersTable.id,
      isActive: usersTable.isActive,
      role: usersTable.role,
      orgId: usersTable.orgId,
    })
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

  if (!demoUser.isActive) {
    // Runs AFTER the marker check on purpose: every read-only verification
    // happens first, so a gate that is going to fail does so without having
    // mutated anything. Repairing before the marker check committed a
    // user.reactivate row into an append-only log for a deploy that was then
    // rejected — truthful about the row it changed, but a permanent entry
    // attached to a deployment that never shipped, and audit_log forbids
    // deleting it.
    //
    // Repair rather than refuse. Throwing here turns ONE operator action --
    // deactivating the demo principal through PATCH /users/:userId/active --
    // into a permanently wedged deploy pipeline: the seed cannot fix it
    // (seedUsers only inserts when the row is ABSENT, and on a fully-seeded
    // database seedAll() skips before seedUsers even runs), so every later
    // deploy fails, including hotfixes with nothing to do with the demo.
    //
    // Blocking the world to protect a demo login is the wrong trade. This is
    // a DEMO_MODE service holding seed data, the demo principal is the only
    // way to log into it, and deactivating it is self-lockout rather than a
    // meaningful seat-management state worth preserving. Only THIS user is
    // touched — deactivating the other seeded users to exercise seat
    // management still works and survives deploys.
    console.warn(
      `[predeploy-seed] demo user ${id} was deactivated — reactivating it. ` +
        "requireAuth rejects an inactive demo user, so leaving it would 401 " +
        "every request. Deactivate a different seeded user if you are testing " +
        "seat management.",
    );
    // Write the audit entry in the SAME transaction as the change. The
    // deactivation that got us here was recorded in audit_log, so an
    // unrecorded reactivation would leave access-review consumers reading a
    // final state of "deactivated" while requireAuth accepts the account --
    // a silent divergence in exactly the trail ADR-0003 commits to keeping
    // auditable. audit_log is append-only (migrations 0002 and 0042), so this
    // row can never be edited or removed afterwards.
    await db.transaction(async (tx) => {
      // Conditional on isActive=false, and the audit row is written only when
      // this statement actually changed something. Two overlapping pre-deploys
      // can both read isActive=false before either transaction starts; an
      // unconditional update would then have both insert a false->true entry,
      // recording two transitions in an append-only log where only one
      // happened. RETURNING makes the winner observable instead of inferred
      // from the stale pre-transaction read.
      const changed = await tx
        .update(usersTable)
        .set({ isActive: true })
        .where(and(eq(usersTable.id, id), eq(usersTable.isActive, false)))
        .returning({ id: usersTable.id });
      if (changed.length === 0) {
        console.warn(
          `[predeploy-seed] demo user ${id} was already reactivated by a ` +
            "concurrent deploy — skipping the duplicate audit entry.",
        );
        return;
      }
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: demoUser.orgId,
        userId: null,
        userRole: "system",
        action: "user.reactivate",
        resourceType: "user",
        resourceId: id,
        changes: {
          isActive: { from: false, to: true },
          reason:
            "predeploy-seed reactivated the DEMO_MODE principal: an inactive " +
            "demo user 401s every request and the seed cannot repair it, so " +
            "refusing would block all future deploys.",
        },
      });
    });
  }

  // Same failure shape as isActive, same reasoning. requireAuth's demo branch
  // reads demoUser.role straight from the database, and PATCH
  // /users/:userId/role is gated on super_admin -- so the default demo
  // principal can demote ITSELF to viewer while exercising user management and
  // then lack the permission to undo it. The seed will not repair it either
  // (seedUsers inserts only when the row is absent). Leaving it would hand
  // back a demo that logs in but cannot reach most of the product, with no
  // route to recovery short of editing the database.
  const expectedRole = USER_ROLES[id as keyof typeof USER_ROLES];
  if (expectedRole && demoUser.role !== expectedRole) {
    const previousRole = demoUser.role;
    console.warn(
      `[predeploy-seed] demo user ${id} has role "${previousRole}" but is ` +
        `seeded as "${expectedRole}" — restoring it. Change a different seeded ` +
        "user's role if you are exercising role management.",
    );
    await db.transaction(async (tx) => {
      const changed = await tx
        .update(usersTable)
        .set({ role: expectedRole })
        .where(and(eq(usersTable.id, id), eq(usersTable.role, previousRole)))
        .returning({ id: usersTable.id });
      if (changed.length === 0) {
        console.warn(
          `[predeploy-seed] demo user ${id} role was already restored by a ` +
            "concurrent deploy — skipping the duplicate audit entry.",
        );
        return;
      }
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: demoUser.orgId,
        userId: null,
        userRole: "system",
        action: "user.role_restore",
        resourceType: "user",
        resourceId: id,
        changes: {
          role: { from: previousRole, to: expectedRole },
          reason:
            "predeploy-seed restored the DEMO_MODE principal's seeded role: " +
            "requireAuth resolves this role for every demo request, and the " +
            "principal can demote itself past the permission needed to undo it.",
        },
      });
    });
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
