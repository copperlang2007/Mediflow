import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Production pool hardening (pre-launch scale audit, H3).
 *
 * Without limits a single runaway query holds a connection forever and
 * starves the default 10-connection pool, taking the whole API down.
 *
 *  - `max` — pool size. node-postgres defaults to 10; 10-20 is plenty for
 *    this workload. Env-overridable via `PG_POOL_MAX`.
 *  - `statement_timeout` — hard per-statement cap (default 30s). This is the
 *    important one: Postgres kills any single query that runs longer.
 *    Env-overridable via `PG_STATEMENT_TIMEOUT_MS`. Audited safe — the
 *    commission reconcile worker and the payout/medicare-id backfill scripts
 *    run only small per-item / per-statement SQL inside their transactions
 *    (statement_timeout is per-STATEMENT, not per-transaction), and the CSV
 *    statement-parse path inserts in small chunks. None needs a per-session
 *    `SET LOCAL statement_timeout` override.
 *  - `idle_in_transaction_session_timeout` — kills a connection left holding
 *    an open transaction (default 60s). The reconcile worker's advisory-locked
 *    transaction does only DB work (the pg-boss `enqueue()` calls are
 *    deferred until after commit), so it never idles inside the txn.
 *  - `connectionTimeoutMillis` — fail fast (default 10s) if the pool cannot
 *    hand out a connection, instead of hanging the request indefinitely.
 *
 * `statement_timeout` / `idle_in_transaction_session_timeout` are passed as
 * pg server parameters via the `options` startup string so every pooled
 * connection inherits them. The test harness uses pglite directly (see
 * artifacts/.../helpers/testDb.ts) and never constructs this `pg.Pool`, so
 * these options do not affect tests.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const statementTimeoutMs = intFromEnv("PG_STATEMENT_TIMEOUT_MS", 30_000);
const idleInTxnTimeoutMs = intFromEnv(
  "PG_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  60_000,
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: intFromEnv("PG_POOL_MAX", 10),
  connectionTimeoutMillis: intFromEnv("PG_CONNECTION_TIMEOUT_MS", 10_000),
  // Server-side guards applied to every connection in the pool.
  statement_timeout: statementTimeoutMs,
  idle_in_transaction_session_timeout: idleInTxnTimeoutMs,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./encryption/medicareId";
export * from "./encryption/pii";
export { sql } from "drizzle-orm";
