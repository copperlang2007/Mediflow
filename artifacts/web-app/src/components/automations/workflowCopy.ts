/**
 * Plain-language wording for automation rules: "When a new lead comes in →
 * create a task and send a text". Covers every trigger and action type the
 * API accepts (routes/automations.ts TRIGGER_TYPES / ACTION_TYPES).
 */
import type { AutomationAction } from "@workspace/api-client-react";

export type TriggerDef = {
  value: string;
  /** Short badge label. */
  label: string;
  /** Completes the sentence "When …". Use {days} for the threshold. */
  phrase: string;
  /** Trigger takes a "within N days" threshold. */
  usesDays?: boolean;
};

export const TRIGGERS: TriggerDef[] = [
  { value: "lead_created", label: "New lead", phrase: "a new lead comes in" },
  { value: "lead_status_changed", label: "Lead status changes", phrase: "a lead's status changes" },
  { value: "contact_created", label: "New client added", phrase: "a new client is added" },
  { value: "contact_status_changed", label: "Client status changes", phrase: "a client's status changes" },
  { value: "contact_assigned", label: "Client assigned", phrase: "a client is assigned to an agent" },
  { value: "contact_no_activity", label: "Client gone quiet", phrase: "a client has had no contact for {days} days", usesDays: true },
  { value: "deal_stage_changed", label: "Deal moves stage", phrase: "a deal moves to a new stage" },
  { value: "task_overdue", label: "Task overdue", phrase: "a task is {days} days overdue", usesDays: true },
  { value: "task_completed", label: "Task completed", phrase: "a task is completed" },
  { value: "license_expires", label: "License expiring", phrase: "an agent's license expires within {days} days", usesDays: true },
  { value: "certification_expiring", label: "Certification expiring", phrase: "a carrier certification expires within {days} days", usesDays: true },
  { value: "ahip_deadline", label: "AHIP deadline", phrase: "the AHIP deadline is within {days} days", usesDays: true },
  { value: "enrollment_period_opens", label: "Enrollment period opens", phrase: "an enrollment period opens" },
  { value: "commission_received", label: "Commission received", phrase: "a commission payment arrives" },
  { value: "commission_missed", label: "Commission missed", phrase: "an expected commission doesn't arrive" },
  { value: "chargeback_received", label: "Chargeback received", phrase: "a carrier claws back a commission" },
  { value: "scheduled", label: "Weekly check", phrase: "the weekly check runs" },
];

export const TRIGGER_BY_VALUE = new Map(TRIGGERS.map((t) => [t.value, t]));

export const ACTIONS: { value: AutomationAction["type"]; label: string; phrase: string }[] = [
  { value: "create_task", label: "Create task", phrase: "create a task" },
  { value: "send_notification", label: "Notify", phrase: "send an in-app alert" },
  { value: "send_email", label: "Send email", phrase: "send an email" },
  { value: "send_sms", label: "Send text", phrase: "send a text" },
  { value: "change_contact_status", label: "Update status", phrase: "update the client's status" },
  { value: "enroll_sequence", label: "Start sequence", phrase: "start a follow-up sequence" },
  { value: "change_deal_stage", label: "Move deal", phrase: "move the deal to a new stage" },
  { value: "create_appointment", label: "Book appointment", phrase: "book an appointment" },
];

export const ACTION_BY_VALUE = new Map(ACTIONS.map((a) => [a.value, a]));

export function triggerLabel(triggerType: string): string {
  return TRIGGER_BY_VALUE.get(triggerType)?.label ?? triggerType.replace(/_/g, " ");
}

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "When a new lead comes in → create a task and send a text" */
export function ruleSentence(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  actions: AutomationAction[] | null | undefined,
): string {
  const def = TRIGGER_BY_VALUE.get(triggerType);
  const days = Number(triggerConfig?.daysThreshold ?? 30) || 30;
  const when = (def?.phrase ?? triggerType.replace(/_/g, " ")).replace("{days}", String(days));
  const does = joinPhrases(
    (actions ?? []).map((a) => ACTION_BY_VALUE.get(a.type)?.phrase ?? a.type.replace(/_/g, " ")),
  );
  return does ? `When ${when} → ${does}` : `When ${when}`;
}
