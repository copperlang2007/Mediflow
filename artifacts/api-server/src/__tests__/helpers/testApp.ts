/**
 * Wires the express `app` to a pglite-backed `db` and a synthetic Clerk
 * auth header so integration tests can hit real route handlers without
 * a live Postgres or Clerk dependency.
 *
 * Usage (every integration test file MUST follow this pattern because
 * vitest only hoists `vi.mock(...)` calls written literally at the top of
 * the test file — calls placed inside helper functions do NOT hoist):
 *
 *     import { vi } from "vitest";
 *     const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
 *       dbF: async () => (await import("../helpers/testApp")).dbMockFactory(),
 *       clerkF: async () => (await import("../helpers/testApp")).clerkMockFactory(),
 *       jobsF: async () => (await import("../helpers/testApp")).jobsMockFactory(),
 *     }));
 *     vi.mock("@workspace/db", dbF);
 *     vi.mock("@clerk/express", clerkF);
 *     vi.mock("../../lib/jobs", jobsF);
 *
 * Auth synthesis:
 *   `clerkMiddleware` is mocked to a no-op and `getAuth(req)` is mocked to
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
    process.env.CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy";
    process.env.CLERK_SECRET_KEY ??= "sk_test_dummy";
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
 * tests of the requireMfa middleware. Real Clerk JWTs carry this in their
 * session claims; the test stub reads it from a header to keep the harness
 * dependency-free.
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
 * Clerk users' two-factor state as the backend API reports it, keyed by user
 * id. Used when a synthetic session token carries no MFA claim
 * (`x-test-mfa-enrolled: absent`), the fallback path in resolveMfaEnrolled.
 */
export const clerkTwoFactorByUser = new Map<string, boolean>();

export const clerkMockFactory = async (): Promise<Record<string, unknown>> => {
  const actual = await import("@clerk/express");
  return {
    ...actual,
    // Only users.getUser is faked; everything else stays the real client.
    clerkClient: new Proxy(actual.clerkClient, {
      get: (target, prop, receiver) =>
        prop === "users"
          ? {
              getUser: async (id: string) => {
                if (!clerkTwoFactorByUser.has(id)) throw new Error(`No Clerk user ${id}`);
                return { id, twoFactorEnabled: clerkTwoFactorByUser.get(id) };
              },
            }
          : Reflect.get(target, prop, receiver),
    }),
    clerkMiddleware:
      () =>
      (
        _req: unknown,
        _res: unknown,
        next: () => void,
      ): void => {
        next();
      },
    getAuth: (req: {
      headers: Record<string, string | string[] | undefined>;
    }): {
      userId: string | null;
      sessionId: string | null;
      sessionClaims: { iat: number; two_factor?: boolean | string };
    } => {
      const userId = req.headers["x-test-user-id"];
      const sessionId = req.headers["x-test-session-id"];
      const mfa = req.headers["x-test-mfa-enrolled"];
      return {
        userId: typeof userId === "string" ? userId : null,
        sessionId: typeof sessionId === "string" ? sessionId : null,
        // Always treat the synthetic JWT as freshly minted so requireRecentAuth passes.
        sessionClaims: mfa === "absent"
          // No session-token template: the token carries no MFA claim at all.
          ? { iat: Math.floor(Date.now() / 1000) }
          : {
              iat: Math.floor(Date.now() / 1000),
              // "as-string" mimics a Clerk template shortcode rendered as text.
              two_factor: mfa === "as-string" ? "true" : mfa === "true",
            },
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
