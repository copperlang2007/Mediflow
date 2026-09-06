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
 * So after the seed returns, this verifies the demo user is actually present
 * and exits non-zero if it is not. Railway then fails the pre-deploy and keeps
 * serving the previous version instead of promoting a broken one.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `@workspace/db` throws at IMPORT time when DATABASE_URL is unset, so it is
// imported dynamically below — after the DEMO_MODE check. A static import
// would make the "not a demo service, skip" path crash on exactly the
// services this gate exists to leave alone.

/** Mirrors `DEFAULT_DEMO_USER_ID` in api-server's `lib/demoMode.ts`. */
const DEFAULT_DEMO_USER_ID = "00000000-0000-4000-8000-000000000010";

function demoUserId(): string {
  const fromEnv = process.env["DEMO_USER_ID"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DEMO_USER_ID;
}

async function main(): Promise<void> {
  if (process.env["DEMO_MODE"] !== "true") {
    console.log(
      "[predeploy-seed] DEMO_MODE is not 'true' — skipping the demo seed. " +
        "This service is not a demo deployment.",
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
  const [{ db }, { usersTable }, { eq }] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
  ]);
  const id = demoUserId();
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(
      `[predeploy-seed] demo user ${id} is still missing after seeding. ` +
        "Refusing to promote a deployment that cannot serve an authenticated " +
        "request. If a concurrent deploy held the seed lock, retry this deploy.",
    );
  }

  console.log(`[predeploy-seed] demo user ${id} present — deploy may proceed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
