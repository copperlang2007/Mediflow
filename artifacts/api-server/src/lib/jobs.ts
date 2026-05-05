/**
 * Background job queue built on pg-boss.
 *
 * Provides a typed singleton queue for:
 *  - License expiry notifications (scheduled daily)
 *  - AHIP reminder emails (scheduled monthly)
 *  - Task auto-assignment on agent events
 *  - Automation rule evaluation
 *  - Fire-and-forget email / SMS sends
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

export const JOB_NAMES = {
  LICENSE_EXPIRY_CHECK: "license-expiry-check",
  AHIP_REMINDER_CHECK: "ahip-reminder-check",
  TASK_AUTO_ASSIGN: "task-auto-assign",
  AUTOMATION_RULE_EVAL: "automation-rule-eval",
  SEND_EMAIL: "send-email",
  SEND_SMS: "send-sms",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// ----- Typed job payloads -----

export interface LicenseExpiryCheckPayload {
  orgId?: string;
}

export interface AhipReminderCheckPayload {
  orgId?: string;
  certificationYear?: number;
}

export interface TaskAutoAssignPayload {
  agentId: string;
  orgId: string;
  trigger: "agent_created" | "agent_status_changed";
}

export interface AutomationRuleEvalPayload {
  orgId: string;
  ruleId?: string;
}

export interface SendEmailPayload {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export interface SendSmsPayload {
  to: string;
  body: string;
}

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

/**
 * Register all background workers.
 * Called from index.ts after pg-boss starts.
 * WorkHandler receives Job<T>[] (batch).
 */
export async function startWorkers(): Promise<void> {
  const boss = await getQueue();

  // Create all queues before scheduling or registering workers (pg-boss v12 requirement)
  for (const name of Object.values(JOB_NAMES)) {
    await boss.createQueue(name);
  }

  // Daily license expiry check at 08:00 UTC
  await boss.schedule(JOB_NAMES.LICENSE_EXPIRY_CHECK, "0 8 * * *", {}, { tz: "UTC" });
  // Monthly AHIP reminder on 1st of month at 09:00 UTC
  await boss.schedule(JOB_NAMES.AHIP_REMINDER_CHECK, "0 9 1 * *", {}, { tz: "UTC" });

  // License expiry worker
  const licenseHandler: WorkHandler<LicenseExpiryCheckPayload> = async (jobs: Job<LicenseExpiryCheckPayload>[]) => {
    const { licenseExpiryCheckWorker } = await import("../workers/licenseExpiryCheck");
    for (const job of jobs) {
      await licenseExpiryCheckWorker(job.data);
    }
  };
  await boss.work<LicenseExpiryCheckPayload>(JOB_NAMES.LICENSE_EXPIRY_CHECK, licenseHandler);

  // AHIP reminder worker
  const ahipHandler: WorkHandler<AhipReminderCheckPayload> = async (jobs: Job<AhipReminderCheckPayload>[]) => {
    const { ahipReminderCheckWorker } = await import("../workers/ahipReminderCheck");
    for (const job of jobs) {
      await ahipReminderCheckWorker(job.data);
    }
  };
  await boss.work<AhipReminderCheckPayload>(JOB_NAMES.AHIP_REMINDER_CHECK, ahipHandler);

  // Task auto-assign worker
  const taskHandler: WorkHandler<TaskAutoAssignPayload> = async (jobs: Job<TaskAutoAssignPayload>[]) => {
    const { taskAutoAssignWorker } = await import("../workers/taskAutoAssign");
    for (const job of jobs) {
      await taskAutoAssignWorker(job.data);
    }
  };
  await boss.work<TaskAutoAssignPayload>(JOB_NAMES.TASK_AUTO_ASSIGN, taskHandler);

  // Email send worker
  const emailHandler: WorkHandler<SendEmailPayload> = async (jobs: Job<SendEmailPayload>[]) => {
    const { sendEmail } = await import("./email");
    for (const job of jobs) {
      const toArray = Array.isArray(job.data.to) ? job.data.to : [job.data.to];
      await sendEmail({
        to: toArray.map((email: string) => ({ email })),
        subject: job.data.subject,
        html: job.data.html,
        text: job.data.text,
      });
    }
  };
  await boss.work<SendEmailPayload>(JOB_NAMES.SEND_EMAIL, emailHandler);

  // SMS send worker
  const smsHandler: WorkHandler<SendSmsPayload> = async (jobs: Job<SendSmsPayload>[]) => {
    const { sendSms } = await import("./sms");
    for (const job of jobs) {
      await sendSms({ to: job.data.to, body: job.data.body });
    }
  };
  await boss.work<SendSmsPayload>(JOB_NAMES.SEND_SMS, smsHandler);

  logger.info("All background workers registered");
}
