/**
 * Background job queue built on pg-boss.
 *
 * Complete job registry:
 *  Scheduled (cron):
 *    license-expiry-check        daily 08:00 UTC
 *    cert-expiry-check           daily 08:05 UTC
 *    check-ahip-deadlines        weekly Monday 08:10 UTC
 *    automation-daily-sweep      nightly 01:00 UTC
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
 */

import { PgBoss, type Job, type WorkHandler } from "pg-boss";
import { logger } from "./logger";

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

// ---- Job name registry ----

export const JOB_NAMES = {
  // Scheduled
  LICENSE_EXPIRY_CHECK: "license-expiry-check",
  CERT_EXPIRY_CHECK: "cert-expiry-check",
  AHIP_DEADLINE_CHECK: "check-ahip-deadlines",
  AUTOMATION_DAILY_SWEEP: "automation-daily-sweep",
  WEEKLY_COMPLIANCE_REPORT: "weekly-compliance-report",
  RETENTION_ENFORCEMENT: "retention-enforcement",
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
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

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

export interface SendSequenceStepPayload {
  sequenceId: string;
  contactId: string;
  stepIndex: number;
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

// ---- Worker registration ----

export async function startWorkers(): Promise<void> {
  const boss = await getQueue();

  // Create all queues first (pg-boss v12 requirement)
  for (const name of Object.values(JOB_NAMES)) {
    if (name === JOB_NAMES.RUN_AUTOMATION_RULES) {
      // Automation rule jobs get 3 retries with 60s exponential backoff
      await boss.createQueue(name, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
    } else {
      await boss.createQueue(name);
    }
  }

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

  // ---- Workers ----

  const licenseHandler: WorkHandler<LicenseExpiryCheckPayload> = async (
    jobs: Job<LicenseExpiryCheckPayload>[],
  ) => {
    const { licenseExpiryCheckWorker } = await import("../workers/licenseExpiryCheck");
    for (const job of jobs) await licenseExpiryCheckWorker(job.data);
  };
  await boss.work<LicenseExpiryCheckPayload>(JOB_NAMES.LICENSE_EXPIRY_CHECK, licenseHandler);

  const certHandler: WorkHandler<CertExpiryCheckPayload> = async (
    jobs: Job<CertExpiryCheckPayload>[],
  ) => {
    const { certExpiryCheckWorker } = await import("../workers/certExpiryCheck");
    for (const job of jobs) await certExpiryCheckWorker(job.data);
  };
  await boss.work<CertExpiryCheckPayload>(JOB_NAMES.CERT_EXPIRY_CHECK, certHandler);

  const ahipHandler: WorkHandler<AhipDeadlineCheckPayload> = async (
    jobs: Job<AhipDeadlineCheckPayload>[],
  ) => {
    const { ahipReminderCheckWorker } = await import("../workers/ahipReminderCheck");
    for (const job of jobs) await ahipReminderCheckWorker(job.data);
  };
  await boss.work<AhipDeadlineCheckPayload>(JOB_NAMES.AHIP_DEADLINE_CHECK, ahipHandler);

  const dailyAutomationSweepHandler: WorkHandler<Record<string, never>> = async () => {
    const { dailyAutomationSweepWorker } = await import(
      "../workers/weeklyAutomationSweep"
    );
    await dailyAutomationSweepWorker();
  };
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
  await boss.work<TaskAutoAssignPayload>(JOB_NAMES.TASK_AUTO_ASSIGN, taskHandler);

  const automationHandler: WorkHandler<RunAutomationRulesPayload> = async (
    jobs: Job<RunAutomationRulesPayload>[],
  ) => {
    const { runAutomationRulesWorker } = await import("../workers/runAutomationRules");
    for (const job of jobs) await runAutomationRulesWorker(job.data);
  };
  await boss.work<RunAutomationRulesPayload>(JOB_NAMES.RUN_AUTOMATION_RULES, automationHandler);

  const sequenceHandler: WorkHandler<SendSequenceStepPayload> = async (
    jobs: Job<SendSequenceStepPayload>[],
  ) => {
    const { sendSequenceStepWorker } = await import("../workers/sendSequenceStep");
    for (const job of jobs) await sendSequenceStepWorker(job.data);
  };
  await boss.work<SendSequenceStepPayload>(JOB_NAMES.SEND_SEQUENCE_STEP, sequenceHandler);

  const offboardingPdfHandler: WorkHandler<GenerateOffboardingPdfPayload> = async (
    jobs: Job<GenerateOffboardingPdfPayload>[],
  ) => {
    const { generateOffboardingPdfWorker } = await import(
      "../workers/generateOffboardingPdf"
    );
    for (const job of jobs) await generateOffboardingPdfWorker(job.data);
  };
  await boss.work<GenerateOffboardingPdfPayload>(
    JOB_NAMES.GENERATE_OFFBOARDING_PDF,
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
  await boss.work<SendScheduledEmailPayload>(JOB_NAMES.SEND_SCHEDULED_EMAIL, emailHandler);

  const smsHandler: WorkHandler<SendScheduledSmsPayload> = async (
    jobs: Job<SendScheduledSmsPayload>[],
  ) => {
    const { sendSMS } = await import("./sms");
    for (const job of jobs) {
      await sendSMS(job.data.to, job.data.body, job.data.agentId ?? "system");
    }
  };
  await boss.work<SendScheduledSmsPayload>(JOB_NAMES.SEND_SCHEDULED_SMS, smsHandler);

  const retentionHandler: WorkHandler<Record<string, never>> = async () => {
    const { retentionEnforcementWorker } = await import("../workers/retentionEnforcement");
    await retentionEnforcementWorker();
  };
  await boss.work<Record<string, never>>(JOB_NAMES.RETENTION_ENFORCEMENT, retentionHandler);

  // ---- Import workers (ad-hoc, triggered by import routes) ----
  const importMondayHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importMondayWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importMondayWorker(job.data);
  };
  await boss.work<{ jobId: string }>(JOB_NAMES.IMPORT_MONDAY, importMondayHandler);

  const importGhlHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importGhlWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importGhlWorker(job.data);
  };
  await boss.work<{ jobId: string }>(JOB_NAMES.IMPORT_GHL, importGhlHandler);

  const importCsvHandler: WorkHandler<{ jobId: string }> = async (jobs) => {
    const { importCsvContactsWorker } = await import("../workers/importProcessing");
    for (const job of jobs) await importCsvContactsWorker(job.data);
  };
  await boss.work<{ jobId: string }>(JOB_NAMES.IMPORT_CSV_CONTACTS, importCsvHandler);

  logger.info("All background workers registered");
}
