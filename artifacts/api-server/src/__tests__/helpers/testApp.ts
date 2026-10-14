/**
 * Wires the express `app` to a pglite-backed `db` and a synthetic sign-in
 * auth header so integration tests can hit real route handlers without
 * a live Postgres or Identity Platform dependency.
 *
 * Usage (every integration test file MUST follow this pattern because
 * vitest only hoists `vi.mock(...)` calls written literally at the top of
 * the test file — calls placed inside helper functions do NOT hoist):
 *
 *     import { vi } from "vitest";
 *     const { dbF, authF, jobsF } = vi.hoisted(() => ({
 *       dbF: async () => (await import("../helpers/testApp")).dbMockFactory(),
 *       authF: async () => (await import("../helpers/testApp")).identityMockFactory(),
 *       jobsF: async () => (await import("../helpers/testApp")).jobsMockFactory(),
 *     }));
 *     vi.mock("@workspace/db", dbF);
 *     vi.mock("../../lib/auth/identity", authF);
 *     vi.mock("../../lib/jobs", jobsF);
 *
 * Auth synthesis:
 *   `identityMiddleware` is mocked to a no-op and `getAuth(req)` is mocked to
 *   read the `x-test-user-id` and `x-test-session-id` headers. The
 *   downstream `requireAuth` middleware then loads the user row from
 *   pglite using that id, so RBAC behaves exactly as in production.
 */
import {
  setupTestDb,
  teardownTestDb,
  type TestDbHandle,
} from "./testDb";

declare global {
  // eslint-disable-next-line no-var
  var __TEST_DB__: TestDbHandle | undefined;
  // eslint-disable-next-line no-var
  var __TEST_ENQUEUED__: Array<{ name: string; data: unknown }> | undefined;
  // Per-test override for the `/readyz` worker-liveness probe: a fake
  // `getWipData()` result. Unset = a single live worker (see jobsMockFactory).
  // eslint-disable-next-line no-var
  var __READYZ_WIP_OVERRIDE__:
    | Array<{ name: string; state: string }>
    | undefined;
}

export function getEnqueuedJobs(): Array<{ name: string; data: unknown }> {
  return globalThis.__TEST_ENQUEUED__ ?? [];
}

export function clearEnqueuedJobs(): void {
  globalThis.__TEST_ENQUEUED__ = [];
}

export async function bootTestDb(): Promise<TestDbHandle> {
  if (!globalThis.__TEST_DB__) {
    process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
    process.env.ALLOWED_ORIGIN ??= "http://localhost";
    globalThis.__TEST_DB__ = await setupTestDb();
    globalThis.__TEST_ENQUEUED__ = [];
  }
  return globalThis.__TEST_DB__;
}

export async function shutdownTestDb(): Promise<void> {
  if (globalThis.__TEST_DB__) {
    await teardownTestDb(globalThis.__TEST_DB__);
    globalThis.__TEST_DB__ = undefined;
  }
}

export function withAuth(
  userId: string,
  sessionId?: string,
): Record<string, string> {
  return {
    "x-test-user-id": userId,
    "x-test-session-id": sessionId ?? `session-${userId}`,
  };
}

/**
 * Synthetic auth headers that also flag the session as MFA-enrolled, for
 * tests of the requireMfa middleware. Real ID tokens carry this as
 * `firebase.sign_in_second_factor`; the test stub reads it from a header.
 */
export function withMfaAuth(
  userId: string,
  mfaEnrolled: boolean,
  sessionId?: string,
): Record<string, string> {
  return {
    ...withAuth(userId, sessionId),
    "x-test-mfa-enrolled": mfaEnrolled ? "true" : "false",
  };
}

// ---- vi.mock factories ------------------------------------------------------

export const dbMockFactory = async (): Promise<Record<string, unknown>> => {
  const handle = globalThis.__TEST_DB__;
  if (!handle) {
    throw new Error(
      "Test DB not booted — call bootTestDb() in beforeAll before importing app/routes.",
    );
  }
  const schema = await import("@workspace/db/schema");
  const encryption = await import("@workspace/db/encryption/medicareId");
  const piiEncryption = await import("@workspace/db/encryption/pii");
  const drizzleOrm = await import("drizzle-orm");
  return {
    ...schema,
    ...encryption,
    ...piiEncryption,
    db: handle.db,
    pool: { end: async () => undefined },
    sql: drizzleOrm.sql,
  };
};

/**
 * Mock for lib/auth/identity: the real module minus token verification.
 * `identityMiddleware` is a no-op and `getAuth(req)` reads synthetic headers:
 *   x-test-user-id       → the identity subject (equal to users.id for test users)
 *   x-test-session-id    → the session id
 *   x-test-mfa-enrolled  → "true" when this sign-in passed a second factor
 *   x-test-email / x-test-email-verified → the token's email and whether it is verified
 *   x-test-auth-time     → sign-in time in seconds (default: now)
 */
export const identityMockFactory = async (): Promise<Record<string, unknown>> => {
  const actual = await import("../../lib/auth/identity");
  return {
    ...actual,
    identityMiddleware:
      () =>
      (_req: unknown, _res: unknown, next: () => void): void => {
        next();
      },
    getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
      const h = (k: string) => {
        const v = req.headers[k];
        return typeof v === "string" ? v : null;
      };
      const subject = h("x-test-user-id");
      const now = Math.floor(Date.now() / 1000);
      return {
        subject,
        sessionId: subject ? (h("x-test-session-id") ?? `session-${subject}`) : null,
        email: h("x-test-email"),
        emailVerified: h("x-test-email-verified") !== "false",
        mfa: h("x-test-mfa-enrolled") === "true",
        // Treat the synthetic token as freshly minted so requireRecentAuth passes;
        // x-test-auth-time (seconds) sets an older sign-in time.
        sessionClaims: subject ? { iat: now, auth_time: Number(h("x-test-auth-time") ?? now) } : null,
      };
    },
  };
};

export const jobsMockFactory = (): Record<string, unknown> => ({
  JOB_NAMES: {
    LICENSE_EXPIRY_CHECK: "license-expiry-check",
    CERT_EXPIRY_CHECK: "cert-expiry-check",
    AHIP_DEADLINE_CHECK: "check-ahip-deadlines",
    AUTOMATION_DAILY_SWEEP: "automation-daily-sweep",
    WEEKLY_COMPLIANCE_REPORT: "weekly-compliance-report",
    RETENTION_ENFORCEMENT: "retention-enforcement",
    IMPORT_MONDAY: "import-monday",
    IMPORT_GHL: "import-ghl",
    IMPORT_CSV_CONTACTS: "import-csv-contacts",
    IMPORT_ROWS_SWEEP: "import-rows-sweep",
    INTEGRATION_EVENTS_PRUNE: "integration-events-prune",
    TASK_AUTO_ASSIGN: "task-auto-assign",
    RUN_AUTOMATION_RULES: "run-automation-rules",
    SEND_SEQUENCE_STEP: "send-sequence-step",
    GENERATE_OFFBOARDING_PDF: "generate-offboarding-pdf",
    SEND_SCHEDULED_EMAIL: "send-scheduled-email",
    SEND_SCHEDULED_SMS: "send-scheduled-sms",
    SUBMIT_CONTRACTING_PACKET: "submit-contracting-packet",
    DIALER_RECONCILE: "dialer-reconcile",
    LEAD_CALLBACK_SWEEP: "lead-callback-sweep",
    STATEMENT_INGEST_POLL: "statement-ingest-poll",
    AEP_RENEWAL_REVIEW: "aep-renewal-review",
    GHL_SYNC: "ghl-sync",
    APPOINTMENT_REMINDERS: "appointment-reminders",
    TRANSCRIBE_RECORDING: "transcribe-recording",
    RECORDINGS_SWEEP: "recordings-sweep",
  },
  transcribeJobKey: (id: string): string => `transcribe:${id}`,
  enqueue: async (name: string, data: unknown): Promise<string> => {
    (globalThis.__TEST_ENQUEUED__ ??= []).push({ name, data });
    return "job-id";
  },
  getQueue: async (): Promise<Record<string, unknown>> => ({
    send: async (): Promise<string> => "job-id",
    on: (): undefined => undefined,
  }),
  // `/readyz` worker-liveness probe calls `peekQueue()`. Tests that exercise
  // readiness override `globalThis.__READYZ_WIP_OVERRIDE__` to simulate live
  // vs. dead workers; default is a single live ("active") worker.
  peekQueue: (): Record<string, unknown> | null => {
    const override = globalThis.__READYZ_WIP_OVERRIDE__;
    return {
      getWipData: (): Array<{ name: string; state: string }> =>
        override ?? [{ name: "send-scheduled-sms", state: "active" }],
    };
  },
  startWorkers: async (): Promise<void> => undefined,
  DEAD_LETTER_QUEUE: "dead-letter",
});
