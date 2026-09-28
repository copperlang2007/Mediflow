/**
 * The demo book of business, as pure data.
 *
 * Shared by seed-demo.ts (which inserts the rows) and seed-demo-coherence.ts
 * (which hangs enrollments, appointments, messages and commission data off
 * them) so both agree on who is a lead, who is a member, which plan each
 * member holds and which policy number it carries.
 *
 * Side-effect free: no database access, no environment reads. Everything is
 * clearly fictional — `@example.com` addresses, 555 phone numbers.
 */
import { stableId } from "./demo-constants";

export const DEMO_AGENTS = {
  carlos: "00000000-0000-4000-8000-000000000020",
  linda: "00000000-0000-4000-8000-000000000021",
} as const;

export const FIRST_NAMES = [
  "Margaret", "Robert", "Patricia", "James", "Linda", "Michael",
  "Barbara", "William", "Elizabeth", "David", "Susan", "Richard",
  "Jessica", "Joseph", "Karen", "Thomas", "Nancy", "Charles",
  "Lisa", "Daniel", "Betty", "Matthew", "Helen", "Anthony",
  "Sandra", "Mark", "Donna", "Steven", "Carol", "Paul",
];
export const LAST_NAMES = [
  "Anderson", "Brown", "Chen", "Davis", "Edwards", "Foster",
  "Garcia", "Hernandez", "Iverson", "Johnson", "Kelly", "Lopez",
  "Miller", "Nguyen", "OBrien", "Patel", "Quinn", "Roberts",
  "Singh", "Taylor", "Underwood", "Valdez", "Williams", "Xu",
  "Young", "Zimmerman", "Adams", "Baker", "Cooper", "Diaz",
];
export const DEMO_STATES = ["FL", "CA", "TX", "NY"] as const;
export const PLAN_TYPES = ["MA", "MAPD", "PDP", "supp"] as const;
export const CONTACT_STATUSES = ["lead", "prospect", "enrolled", "retained"] as const;
export const DEMO_CONTACT_COUNT = 30;

/**
 * Carriers members are enrolled with — all ones Carlos (the writing agent)
 * is appointed at in the seed. Names match DEFAULT_CARRIERS in
 * artifacts/api-server/src/lib/carrierSeed.ts.
 */
export const MEMBER_CARRIERS = ["Aetna/CVS", "Humana", "UnitedHealth/AARP", "Devoted"] as const;

export interface DemoContact {
  index: number;
  id: string;
  firstName: string;
  lastName: string;
  stateCode: (typeof DEMO_STATES)[number];
  status: (typeof CONTACT_STATUSES)[number];
  /** Rotated so members hold a real mix of MA / MAPD / PDP / supplement plans. */
  planType: (typeof PLAN_TYPES)[number];
  /** Current members are all written and serviced by Carlos (the appointed agent). */
  assignedAgentId: string;
  isMember: boolean;
  /** Only for members. */
  carrierName: (typeof MEMBER_CARRIERS)[number] | null;
}

export function demoContact(i: number): DemoContact {
  const firstName = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const lastName = LAST_NAMES[(i * 7) % LAST_NAMES.length]!;
  const status = CONTACT_STATUSES[i % CONTACT_STATUSES.length]!;
  const isMember = status === "enrolled" || status === "retained";
  return {
    index: i,
    id: stableId("contact", `${firstName}-${lastName}-${i}`),
    firstName,
    lastName,
    stateCode: DEMO_STATES[i % DEMO_STATES.length]!,
    status,
    planType: PLAN_TYPES[(i + Math.floor(i / 4)) % PLAN_TYPES.length]!,
    // Leads and prospects are split between the two agents; members stay
    // with Carlos, who is licensed and appointed (Linda is still onboarding
    // and cannot have written business yet).
    assignedAgentId: isMember || i % 3 !== 0 ? DEMO_AGENTS.carlos : DEMO_AGENTS.linda,
    isMember,
    // Round-robin over the members (k = 0..13) so Aetna and Humana — the two
    // carriers with seeded statements — have 4 members each (one per line).
    carrierName: isMember
      ? MEMBER_CARRIERS[(2 * Math.floor(i / 4) + (i % 4) - 2) % MEMBER_CARRIERS.length]!
      : null,
  };
}

export function demoContacts(): DemoContact[] {
  return Array.from({ length: DEMO_CONTACT_COUNT }, (_, i) => demoContact(i));
}

export function demoMembers(): DemoContact[] {
  return demoContacts().filter((c) => c.isMember);
}

/** Fictional carrier policy number for a member's current-year plan. */
export function demoPolicyNumber(c: DemoContact, planYear: number): string {
  const prefix = (c.carrierName ?? "XX").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  return `${prefix}-${planYear}-${String(10000 + c.index * 37).padStart(6, "0")}`;
}

/**
 * Demo licenses. Expiry is RELATIVE to the day the seed runs so the demo
 * stays coherent:
 *   Carlos CA / TX: current for another year+
 *   Carlos FL:      expires in 45 days (shows under "expiring soon")
 *   Carlos NY:      expired 20 days ago but still STORED as 'active' — the
 *                   case the shared license definition exists for: every page
 *                   reads it as expired (3 of 4 active).
 *   Linda FL:       current (she is still onboarding for other reasons)
 */
export const DEMO_LICENSES: ReadonlyArray<{ agentId: string; state: string; expiresInDays: number }> = [
  { agentId: DEMO_AGENTS.carlos, state: "CA", expiresInDays: 400 },
  { agentId: DEMO_AGENTS.carlos, state: "TX", expiresInDays: 540 },
  { agentId: DEMO_AGENTS.carlos, state: "FL", expiresInDays: 45 },
  { agentId: DEMO_AGENTS.carlos, state: "NY", expiresInDays: -20 },
  { agentId: DEMO_AGENTS.linda, state: "FL", expiresInDays: 300 },
];

/** The expiry the original seed hard-coded on every license. */
export const LEGACY_LICENSE_EXPIRY = "2026-01-15T00:00:00.000Z";

/**
 * Six distinct activities for the dashboard feed (the original seed rotated
 * three bodies over six rows, which rendered as the same three entries twice).
 */
export const ACTIVITY_SCRIPT: ReadonlyArray<{ type: "call_log" | "note" | "email"; body: string }> = [
  { type: "call_log", body: "Intro call — interested in comparing Medicare Advantage options." },
  { type: "note", body: "Prefers a morning appointment; wants their current doctors checked against the network." },
  { type: "email", body: "Sent the plan comparison summary we discussed." },
  { type: "call_log", body: "Annual review call — happy with the current plan, no changes needed." },
  { type: "note", body: "Asked about adding a standalone Part D plan next year." },
  { type: "email", body: "Sent a reminder about the upcoming annual review appointment." },
];

/** The three bodies the original seed repeated. */
export const LEGACY_ACTIVITY_BODIES = [
  "Talked through plan options. Sending Aetna SOB.",
  "Lead wants to compare Humana vs UHC for Q4.",
  "Sent follow-up summary email.",
];
