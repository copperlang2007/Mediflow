/**
 * Background job queue built on pg-boss.
 *
 * Complete job registry:
 *  Scheduled (cron):
 *    license-expiry-check        daily 08:00 UTC
 *    cert-expiry-check           daily 08:05 UTC
 *    check-ahip-deadlines        weekly Monday 08:10 UTC
 *    automation-daily-sweep      nightly 01:00 UTC
 *    export-anomaly-check        daily 02:15 UTC
 *
 *  Ad-hoc (enqueue via `enqueue(JOB_NAMES.X, data)`):
 *    task-auto-assign            on agent creation / status change
 *    run-automation-rules        on trigger events
 *    send-sequence-step          outreach sequence scheduler
 *    generate-offboarding-pdf    on agent offboard
 *    send-scheduled-email        deferred transactional email
 *    send-scheduled-sms          deferred transactional SMS
 *
 * IMPORTANT: pg-boss v12 requires createQueue() before schedule()/work().
 *
 * Retry & dead-letter:
 *   Every queue is registered with a retry policy (see `DEFAULT_RETRY` /
 *   `RETRY_OVERRIDES`) and a shared `dead-letter` queue. A transient failure
 *   is retried with exponential backoff; a job that exhausts its retries is
 *   copied to the dead-letter queue, where `deadLetterHandler` logs it at
 *   ERROR level and captures it to Sentry. Non-idempotent jobs opt out of
 *   retries via `NO_RETRY`.
 *
 * Concurrency:
 *   pg-boss v12 dropped `teamSize` / `teamConcurrency` (the v9-era names) in
 *   favor of `batchSize` (jobs fetched per poll) and `localConcurrency`
 *   (parallel worker loops on this node). Each `boss.work()` call below
 *   passes both explicitly so no single slow job (e.g. PDF generation) can
 *   starve the rest of the queue. Heavy/expensive jobs are isolated at 1;
 *   high-volume cheap jobs get 5; outreach-rate-sensitive jobs get 3.
 *   Scheduled crons stay at the pg-boss default (1) since they're singletons.
 */

import { PgBoss, type Job, type Queue, type WorkHandler } from "pg-boss";
import { logger } from "./logger";
import { captureWorkerError } from "./sentry";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for pg-boss job queue");
}

let _boss: PgBoss | null = null;

export async function getQueue(): Promise<PgBoss> {
  if (_boss) return _boss;

  _boss = new PgBoss({
    connectionString: DATABASE_URL,
    schema: "pgboss",
    supervise: true,
  });

  _boss.on("error", (err: Error) => {
    logger.error({ err }, "pg-boss error");
  });

  await _boss.start();
  logger.info("pg-boss job queue started");

  return _boss;
}

/**
 * Returns the already-started pg-boss instance, or `null` if the queue has
 * not been started yet. Unlike `getQueue()` this NEVER starts pg-boss — it is
 * for read-only callers (e.g. the `/readyz` worker-liveness probe) that must
 * not have a side effect of booting the queue.
 */
export function peekQueue(): PgBoss | null {
  return _boss;
}

// ---- Job name registry ----

export const JOB_NAMES = {
  // Scheduled
  LICENSE_EXPIRY_CHECK: "license-expiry-check",
  CERT_EXPIRY_CHECK: "cert-expiry-check",
  AHIP_DEADLINE_CHECK: "check-ahip-deadlines",
  AUTOMATION_DAILY_SWEEP: "automation-daily-sweep",
  WEEKLY_COMPLIANCE_REPORT: "weekly-compliance-report",
  RETENTION_ENFORCEMENT: "retention-enforcement",
  COMMISSION_MISSED_PAYMENT_CHECK: "commission-missed-payment-check",
  EXPORT_ANOMALY_CHECK: "export-anomaly-check",
  // Import workers (ad-hoc, enqueued from import routes)
  IMPORT_MONDAY: "import-monday",
  IMPORT_GHL: "import-ghl",
  IMPORT_CSV_CONTACTS: "import-csv-contacts",
  // Ad-hoc
  TASK_AUTO_ASSIGN: "task-auto-assign",
  RUN_AUTOMATION_RULES: "run-automation-rules",
  SEND_SEQUENCE_STEP: "send-sequence-step",
  GENERATE_OFFBOARDING_PDF: "generate-offboarding-pdf",
  SEND_SCHEDULED_EMAIL: "send-scheduled-email",
  SEND_SCHEDULED_SMS: "send-scheduled-sms",
  RECONCILE_COMMISSION_STATEMENT: "reconcile-commission-statement",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Shared dead-letter queue. When ANY job above exhausts its retries, pg-boss
 * copies the failed job's payload here (see the `deadLetter` queue option set
 * at registration). A single worker on this queue logs the permanent failure
 * at ERROR level and reports it to Sentry, so an exhausted-retry failure can
 * never disappear into a single log line again.
 *
 * Not part of `JOB_NAMES` because it is infrastructure, not an enqueue target
 * for application code.
 */
export const DEAD_LETTER_QUEUE = "dead-letter" as const;

// ---- Retry configuration ---------------------------------------------------

/**
 * Default retry policy applied to every job queue at registration.
 *
 * pg-boss support: `retryLimit` (attempts after the first), `retryDelay`
 * (seconds), `retryBackoff` (exponential). 3 retries with a 30s base and
 * exponential backoff rides out transient failures (network blips, provider
 * 503s) without hammering a struggling dependency.
 *
 * SAFETY: aggressive retries are only correct for IDEMPOTENT handlers — a
 * non-idempotent handler retried after a partial success double-applies its
 * side effects. The key workers were made idempotent in prior PRs (reconcile
 * #66/#69, sendSequenceStep #76, taskAutoAssign #75, the sweep #89), and the
 * scheduled checks dedup via DB constraints. Jobs that are NOT safe to retry
 * get `NO_RETRY` instead (see `RETRY_OVERRIDES`).
 */
const DEFAULT_RETRY: Pick<Queue, "retryLimit" | "retryDelay" | "retryBackoff"> = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
};

/** Retry policy for non-idempotent jobs: fail fast, never auto-retry. */
const NO_RETRY: Pick<Queue, "retryLimit" | "retryDelay" | "retryBackoff"> = {
  retryLimit: 0,
};

/**
 * Per-job retry overrides. Anything not listed here uses `DEFAULT_RETRY`.
 *
 *  - GENERATE_OFFBOARDING_PDF is NOT idempotent: each run mints a fresh
 *    `randomUUID()` document id and writes a new object-storage blob + a new
 *    `documents` row. A retry after a partial success would leave duplicate
 *    PDFs and document records. It gets `NO_RETRY` — a failed offboarding PDF
 *    surfaces via the dead-letter handler for manual re-trigger instead.
 */
const RETRY_OVERRIDES: Partial<
  Record<JobName, Pick<Queue, "retryLimit" | "retryDelay" | "retryBackoff">>
> = {
  [JOB_NAMES.GENERATE_OFFBOARDING_PDF]: NO_RETRY,
};

/**
 * Builds the `createQueue()` options for a job: its retry policy plus the
 * shared dead-letter queue so exhausted-retry failures are captured.
 */
function queueOptions(name: JobName): Omit<Queue, "name"> {
  return {
    ...(RETRY_OVERRIDES[name] ?? DEFAULT_RETRY),
    deadLetter: DEAD_LETTER_QUEUE,
  };
}

// ---- Typed job payloads ----

export interface LicenseExpiryCheckPayload {
  orgId?: string;
}

export interface CertExpiryCheckPayload {
  orgId?: string;
}

export interface AhipDeadlineCheckPayload {
  orgId?: string;
  certificationYear?: number;
}

export interface TaskAutoAssignPayload {
  agentId: string;
  orgId: string;
  trigger: "agent_created" | "agent_status_changed";
}

export interface RunAutomationRulesPayload {
  orgId: string;
  trigger: string;
  resourceType: string;
  resourceId: string;
  context?: Record<string, unknown>;
}

/**
 * Payload for the SEND_SEQUENCE_STEP job.
 *
 * `stepId` is the authoritative pointer at which step to run. New
 * enqueues set it. `stepIndex` is the legacy positional pointer; it is
 * still accepted for in-flight jobs whose payload was written before
 * the stepId migration (see migration 0014 and
 * `workers/sendSequenceStep.ts`). After one deploy cycle, drop the
 * fallback and make `stepId` required.
 */
export interface SendSequenceStepPayload {
  sequenceId: string;
  contactId: string;
  stepId?: string;
  stepIndex?: number;
  channel: "email" | "sms";
}

export interface GenerateOffboardingPdfPayload {
  agentId: string;
  orgId: string;
  offboardDate: string;
}

export interface SendScheduledEmailPayload {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Record<string, string>;
}

export interface SendScheduledSmsPayload {
  to: string;
  body: string;
  agentId?: string;
  mediaUrl?: string[];
}

export interface ReconcileCommissionStatementPayload extends Record<string, unknown> {
  statementId: string;
  orgId: string;
}

export interface CommissionMissedPaymentCheckPayload extends Record<string, unknown> {
  orgId?: string;
}

// ---- Enqueue helper ----

/** Send a typed job to the queue. Never throws. */
export async function enqueue<T extends Record<string, unknown>>(
  name: JobName,
  data: T,
  options?: Parameters<PgBoss["send"]>[2],
): Promise<string | null> {
  try {
    const boss = await getQueue();
    return await boss.send(name, data, options);
  } catch (err) {
    logger.error({ err, name }, "Failed to enqueue job");
    return null;
  }
}

// ---- Dead-letter handler ----

/**
 * Shape of a job that landed in the dead-letter queue. pg-boss copies the
 * original job's payload (and metadata when `includeMetadata` is set) here
 * after retries are exhausted.
 */
interface DeadLetterPayload extends Record<string, unknown> {
  /** Name of the queue the job originally failed on, if recoverable. */
  name?: string;
}

/**
 * Handles every permanently-failed job. A job reaches this queue ONLY after
 * exhausting all retries, so each entry is a real, operator-actionable
 * failure: it is logged at ERROR level with full context AND captured to
 * Sentry via `captureWorkerError`.
 *
 * Exported for unit testing.
 */
export async function deadLetterHandler(
  jobs: Job<DeadLetterPayload>[],
): Promise<void> {
  for (const job of jobs) {
    const originalQueue =
      typeof job.data?.name === "string" ? job.data.name : "unknown";
    const context = {
      deadLetterJobId: job.id,
      originalQueue,
      job: DEAD_LETTER_QUEUE,
    };
    logger.error(
      { ...context, payload: job.data },
      "Job exhausted all retries and was dead-lettered",
    );
    captureWorkerError(
      new Error(`Job permanently failed after retries: ${originalQueue}`),
      context,
    );
  }
}

// ---- Worker registration ----

export async function startWorkers(): Promise<void> {
  const boss = await getQueue();

  // Create all job queues first (pg-boss v12 requirement). Every queue gets a
  // retry policy and the shared dead-letter queue — see `queueOptions()`.
  for (const name of Object.values(JOB_NAMES)) {
    await boss.createQueue(name, queueOptions(name));
  }

  // The dead-letter queue itself: no retries (a permanently-failed job must
  // not loop), no further dead-letter target.
  await boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 0 });
  // One worker drains the dead-letter queue, logging + Sentry-capturing every
  // exhausted-retry failure across all job types.
  await boss.work<DeadLetterPayload>(DEAD_LETTER_QUEUE, deadLetterHandler);

  // ---- Scheduled jobs ----

  // Daily license expiry check at 08:00 UTC
  await boss.schedule(JOB_NAMES.LICENSE_EXPIRY_CHECK, "0 8 * * *", {}, { tz: "UTC" });
  // Daily carrier cert expiry check at 08:05 UTC
  await boss.schedule(JOB_NAMES.CERT_EXPIRY_CHECK, "5 8 * * *", {}, { tz: "UTC" });
  // Weekly AHIP deadline check — every Monday at 08:10 UTC
  await boss.schedule(JOB_NAMES.AHIP_DEADLINE_CHECK, "10 8 * * 1", {}, { tz: "UTC" });
  // Nightly automation sweep — every day at 01:00 UTC (time-based rules)
  await boss.schedule(JOB_NAMES.AUTOMATION_DAILY_SWEEP, "0 1 * * *", {}, { tz: "UTC" });
  // Weekly compliance report — every Monday at 06:00 UTC
  await boss.schedule(JOB_NAMES.WEEKLY_COMPLIANCE_REPORT, "0 6 * * 1", {}, { tz: "UTC" });
  // Daily retention enforcement — 02:00 UTC; soft-deletes expired records, creates review tasks
  await boss.schedule(JOB_NAMES.RETENTION_ENFORCEMENT, "0 2 * * *", {}, { tz: "UTC" });
  // Daily commission missed-payment check — 02:30 UTC
  await boss.schedule(
    JOB_NAMES.COMMISSION_MISSED_PAYMENT_CHECK,
    "30 2 * * *",
    {},
    { tz: "UTC" },
  );
  // Daily export-volume anomaly check — 02:15 UTC (off-peak, after retention
  // enforcement at 02:00 but before missed-payment at 02:30).
  await boss.schedule(JOB_NAMES.EXPORT_ANOMALY_CHECK, "15 2 * * *", {}, { tz: "UTC" });

  // ---- Workers ----

  const licenseHandler: WorkHandler<LicenseExpiryCheckPayload> = async (
    jobs: Job<LicenseExpiryCheckPayload>[],
  ) => {
    const { licenseExpiryCheckWorker } = await import("../workers/licenseExpiryCheck");
    for (const job of jobs) await licenseExpiryCheckWorker(job.data);
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<LicenseExpiryCheckPayload>(JOB_NAMES.LICENSE_EXPIRY_CHECK, licenseHandler);

  const certHandler: WorkHandler<CertExpiryCheckPayload> = async (
    jobs: Job<CertExpiryCheckPayload>[],
  ) => {
    const { certExpiryCheckWorker } = await import("../workers/certExpiryCheck");
    for (const job of jobs) await certExpiryCheckWorker(job.data);
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<CertExpiryCheckPayload>(JOB_NAMES.CERT_EXPIRY_CHECK, certHandler);

  const ahipHandler: WorkHandler<AhipDeadlineCheckPayload> = async (
    jobs: Job<AhipDeadlineCheckPayload>[],
  ) => {
    const { ahipReminderCheckWorker } = await import("../workers/ahipReminderCheck");
    for (const job of jobs) await ahipReminderCheckWorker(job.data);
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<AhipDeadlineCheckPayload>(JOB_NAMES.AHIP_DEADLINE_CHECK, ahipHandler);

  const dailyAutomationSweepHandler: WorkHandler<Record<string, never>> = async () => {
    const { dailyAutomationSweepWorker } = await import(
      "../workers/weeklyAutomationSweep"
    );
    await dailyAutomationSweepWorker();
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<Record<string, never>>(
    JOB_NAMES.AUTOMATION_DAILY_SWEEP,
    dailyAutomationSweepHandler,
  );

  const weeklyComplianceReportHandler: WorkHandler<Record<string, never>> = async () => {
    const { weeklyComplianceReportWorker } = await import(
      "../workers/weeklyComplianceReport"
    );
    await weeklyComplianceReportWorker();
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<Record<string, never>>(
    JOB_NAMES.WEEKLY_COMPLIANCE_REPORT,
    weeklyComplianceReportHandler,
  );

  const taskHandler: WorkHandler<TaskAutoAssignPayload> = async (
    jobs: Job<TaskAutoAssignPayload>[],
  ) => {
    const { taskAutoAssignWorker } = await import("../workers/taskAutoAssign");
    for (const job of jobs) await taskAutoAssignWorker(job.data);
  };
  // Triggered on agent create / status change — modest fan-out.
  await boss.work<TaskAutoAssignPayload>(
    JOB_NAMES.TASK_AUTO_ASSIGN,
    { batchSize: 3, localConcurrency: 3 },
    taskHandler,
  );

  const automationHandler: WorkHandler<RunAutomationRulesPayload> = async (
    jobs: Job<RunAutomationRulesPayload>[],
  ) => {
    const { runAutomationRulesWorker } = await import("../workers/runAutomationRules");
    for (const job of jobs) await runAutomationRulesWorker(job.data);
  };
  // High-volume, cheap evaluation work — parallelize aggressively.
  await boss.work<RunAutomationRulesPayload>(
    JOB_NAMES.RUN_AUTOMATION_RULES,
    { batchSize: 5, localConcurrency: 5 },
    automationHandler,
  );

  const sequenceHandler: WorkHandler<SendSequenceStepPayload> = async (
    jobs: Job<SendSequenceStepPayload>[],
  ) => {
    const { sendSequenceStepWorker } = await import("../workers/sendSequenceStep");
    for (const job of jobs) await sendSequenceStepWorker(job.data);
  };
  // Outreach-rate sensitive — keep fan-out conservative to avoid carrier
  // throttling and maintain spacing across recipients.
  await boss.work<SendSequenceStepPayload>(
    JOB_NAMES.SEND_SEQUENCE_STEP,
    { batchSize: 3, localConcurrency: 3 },
    sequenceHandler,
  );

  const offboardingPdfHandler: WorkHandler<GenerateOffboardingPdfPayload> = async (
    jobs: Job<GenerateOffboardingPdfPayload>[],
  ) => {
    const { generateOffboardingPdfWorker } = await import(
      "../workers/generateOffboardingPdf"
    );
    for (const job of jobs) await generateOffboardingPdfWorker(job.data);
  };
  // Heavy PDF generation — isolate at 1 so it can't starve other queues.
  await boss.work<GenerateOffboardingPdfPayload>(
    JOB_NAMES.GENERATE_OFFBOARDING_PDF,
    { batchSize: 1, localConcurrency: 1 },
    offboardingPdfHandler,
  );

  const emailHandler: WorkHandler<SendScheduledEmailPayload> = async (
    jobs: Job<SendScheduledEmailPayload>[],
  ) => {
    const { sendEmail } = await import("./email");
    for (const job of jobs) {
      const toArray = Array.isArray(job.data.to) ? job.data.to : [job.data.to];
      await sendEmail({
        to: toArray.map((email: string) => ({ email })),
        subject: job.data.subject,
        html: job.data.html,
        text: job.data.text,
        replyTo: job.data.replyTo,
        tags: job.data.tags,
      });
    }
  };
  // Transactional email — high volume, provider handles its own rate limiting.
  await boss.work<SendScheduledEmailPayload>(
    JOB_NAMES.SEND_SCHEDULED_EMAIL,
    { batchSize: 5, localConcurrency: 5 },
    emailHandler,
  );

  const smsHandler: WorkHandler<SendScheduledSmsPayload> = async (
    jobs: Job<SendScheduledSmsPayload>[],
  ) => {
    const { sendSMS } = await import("./sms");
    for (const job of jobs) {
      await sendSMS(job.data.to, job.data.body, job.data.agentId ?? "system");
    }
  };
  // SMS — outreach-rate sensitive, carriers throttle aggressively.
  await boss.work<SendScheduledSmsPayload>(
    JOB_NAMES.SEND_SCHEDULED_SMS,
    { batchSize: 3, localConcurrency: 3 },
    smsHandler,
  );

  const retentionHandler: WorkHandler<Record<string, never>> = async () => {
    const { retentionEnforcementWorker } = await import("../workers/retentionEnforcement");
    await retentionEnforcementWorker();
  };
  // Scheduled cron — singleton, default concurrency (1) is intentional.
  await boss.work<Record<string, never>>(JOB_NAMES.RETENTION_ENFORCEMENT, retentionHandler);

  // ---- Import workers (ad-hoc, triggered by import routes) ----
  const importMondayHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importMondayWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importMondayWorker(job.data);
  };
  // Import workers — large file work; ok to parallelize 2-wide.
  await boss.work<{ jobId: string }>(
    JOB_NAMES.IMPORT_MONDAY,
    { batchSize: 2, localConcurrency: 2 },
    importMondayHandler,
  );

  const importGhlHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importGhlWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importGhlWorker(job.data);
  };
  await boss.work<{ jobId: string }>(
    JOB_NAMES.IMPORT_GHL,
    { batchSize: 2, localConcurrency: 2 },
    importGhlHandler,
  );

  const importCsvHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importCsvContactsWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importCsvContactsWorker(job.data);
  };
  await boss.work<{ jobId: string }>(
    JOB_NAMES.IMPORT_CSV_CONTACTS,
    { batchSize: 2, localConcurrency: 2 },
    importCsvHandler,
  );

  const reconcileCommissionHandler: WorkHandler<ReconcileCommissionStatementPayload> = async (
    jobs: Job<ReconcileCommissionStatementPayload>[],
  ) => {
    const { reconcileCommissionStatementWorker } = await import(
      "../workers/reconcileCommissionStatement"
    );
    for (const job of jobs) await reconcileCommissionStatementWorker(job.data);
  };
  await boss.work<ReconcileCommissionStatementPayload>(
    JOB_NAMES.RECONCILE_COMMISSION_STATEMENT,
    reconcileCommissionHandler,
  );

  const missedPaymentHandler: WorkHandler<CommissionMissedPaymentCheckPayload> = async (
    jobs: Job<CommissionMissedPaymentCheckPayload>[],
  ) => {
    const { commissionMissedPaymentCheckWorker } = await import(
      "../workers/commissionMissedPaymentCheck"
    );
    for (const job of jobs) await commissionMissedPaymentCheckWorker(job.data);
  };
  await boss.work<CommissionMissedPaymentCheckPayload>(
    JOB_NAMES.COMMISSION_MISSED_PAYMENT_CHECK,
    missedPaymentHandler,
  );

  const exportAnomalyHandler: WorkHandler<Record<string, never>> = async () => {
    const { exportAnomalyCheckWorker } = await import(
      "../workers/exportAnomalyCheck"
    );
    await exportAnomalyCheckWorker();
  };
  // Scheduled cron — singleton; one pass per node, no fan-out.
  await boss.work<Record<string, never>>(
    JOB_NAMES.EXPORT_ANOMALY_CHECK,
    { batchSize: 1, localConcurrency: 1 },
    exportAnomalyHandler,
  );

  logger.info("All background workers registered");
}
