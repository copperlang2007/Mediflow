/**
 * AEP annual-review task generation.
 *
 * Medicare Advantage (MA / MAPD) plans renew on **January 1** every year.
 * The selling/renewal season — AEP (Annual Enrollment Period) — runs
 * **Oct 15 – Dec 7**, and **Oct 1** is when the next plan year's details
 * become available. So every existing member's annual review appointment
 * must be SET BEFORE Oct 1, otherwise the agent walks into AEP without a
 * booked review and risks losing the renewal.
 *
 * This module creates one "set the annual review appointment" to-do per
 * current MA member each fall, assigned to that member's agent, due before
 * Oct 1 of the current year. It runs as an annual cron (see jobs.ts) and is
 * idempotent — running it twice in a season never duplicates a member's task.
 *
 * ## Who is a "member"?
 *
 * The CRM `contacts.status` enum is
 * `lead | prospect | enrolled | retained | lost | do_not_contact`. The two
 * statuses that represent a CURRENT client/member (someone whose plan is up
 * for renewal) are **`enrolled`** (newly enrolled this season) and
 * **`retained`** (an existing client kept across a prior renewal). We further
 * restrict to MA-family plans via `contacts.current_plan_type IN ('MA','MAPD')`
 * because only Medicare Advantage plans drive the AEP annual-review motion
 * (PDP/supp follow different cycles). A member must also have an
 * `assigned_agent_id` — the task is assigned to that agent's user — and that
 * agent must have a linked `user_id` (tasks are assigned to a USER, and we
 * skip agents that have no user to assign to). Soft-deleted contacts
 * (`deleted_at IS NOT NULL`) are excluded.
 *
 * ## Dedup / idempotency
 *
 * Each generated task carries a deterministic `autoAssignTrigger`:
 *
 *     aep_renewal:<year>:<contactId>
 *
 * Before inserting we check whether a `task_instances` row with that exact
 * trigger already exists for the org; if so we skip. The whole per-org pass
 * runs inside a transaction holding a per-org Postgres advisory lock
 * (mirroring the retention-enforcement worker), so two concurrent runs — a
 * clock-skewed cron double-fire or a manual admin re-trigger overlapping the
 * scheduled run — can't both pass the existence check and double-insert.
 *
 * We intentionally reuse the existing `auto_assign_trigger` column rather than
 * adding a new column + migration. The partial unique index
 * `task_instances_auto_assign_unique` only covers rows where BOTH
 * `template_id` and `agent_id` are non-null; these AEP rows have no template
 * (`template_id IS NULL`), so they are not governed by that index and the
 * query-then-insert guard (serialised by the advisory lock) is what enforces
 * idempotency. No schema change is required.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db as defaultDb,
  agentsTable,
  contactsTable,
  organizationsTable,
  taskInstancesTable,
  type Contact,
} from "@workspace/db";
import { logger } from "../logger";

/** Contact statuses that represent a current client/member up for renewal. */
const MEMBER_STATUSES: Contact["status"][] = ["enrolled", "retained"];

/** Plan types whose renewal drives the AEP annual-review motion. */
const MA_PLAN_TYPES = ["MA", "MAPD"] as const;

/**
 * Drizzle handle this module accepts. `typeof defaultDb | any` mirrors the
 * `CallbackDb` pattern in lib/leadQueue/callbacks.ts: the pglite test handle is
 * structurally compatible at runtime but its TS type (PgliteDatabase) is not
 * assignable to NodePgDatabase, so the union keeps the injectable seam usable
 * from the test harness without a cast at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = typeof defaultDb | any;

export interface AepRenewalOptions {
  /** Inject a drizzle handle (defaults to the shared pool). Tests pass pglite. */
  db?: DbLike;
  /** "Now" — drives the season year and the default due date. Defaults to real time. */
  now?: Date;
  /**
   * Explicit due date for every generated task. Defaults to **Sept 30** of the
   * season year at 23:59:59 UTC — i.e. before Oct 1, when the next plan year's
   * details drop.
   */
  dueAt?: Date;
  /** Restrict to a single org. Omit to sweep every org. */
  orgId?: string;
}

export interface AepRenewalSummary {
  /** Season year derived from `now` (the year whose Jan 1 renewal we prep for next is `year + 1`). */
  year: number;
  /** Tasks newly created this run. */
  created: number;
  /** Eligible members skipped because a task for this season already existed. */
  skipped: number;
  /** Per-org breakdown. */
  byOrg: Array<{ orgId: string; created: number; skipped: number }>;
}

/** Deterministic dedup key persisted in `task_instances.auto_assign_trigger`. */
export function aepRenewalTrigger(year: number, contactId: string): string {
  return `aep_renewal:${year}:${contactId}`;
}

/**
 * Default due date: Sept 30 of `year`, 23:59:59 UTC. The appointment must be
 * set BEFORE Oct 1 (when new plan details become available), so the to-do is
 * due the last day of September.
 */
export function defaultAepDueDate(year: number): Date {
  return new Date(Date.UTC(year, 8, 30, 23, 59, 59));
}

type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

/**
 * Generate this season's AEP annual-review tasks. Returns a created/skipped
 * summary. Safe to re-run within a season (idempotent per (year, contact)).
 */
export async function generateAepRenewalTasks(
  opts: AepRenewalOptions = {},
): Promise<AepRenewalSummary> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const year = now.getUTCFullYear();
  const dueAt = opts.dueAt ?? defaultAepDueDate(year);

  const orgs = opts.orgId
    ? [{ id: opts.orgId }]
    : await db.select({ id: organizationsTable.id }).from(organizationsTable);

  let created = 0;
  let skipped = 0;
  const byOrg: AepRenewalSummary["byOrg"] = [];

  for (const org of orgs) {
    // Serialise the per-org pass behind an advisory lock so a concurrent
    // re-run (cron double-fire / manual admin trigger) can't both pass the
    // existence check and double-insert. Transaction-scoped: auto-released
    // on commit. Different orgs still run concurrently (key is per-org).
    const result = await db.transaction(async (tx: Tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`aep_renewal:${org.id}:${year}`}))`,
      );
      return runOrgPass(tx, org.id, year, dueAt);
    });

    created += result.created;
    skipped += result.skipped;
    byOrg.push({ orgId: org.id, created: result.created, skipped: result.skipped });
  }

  logger.info(
    { year, created, skipped, orgs: orgs.length },
    "aep-renewal: generation complete",
  );

  return { year, created, skipped, byOrg };
}

async function runOrgPass(
  tx: Tx,
  orgId: string,
  year: number,
  dueAt: Date,
): Promise<{ created: number; skipped: number }> {
  // Current MA/MAPD members with an assigned agent who has a linked user.
  // Joining agents enforces "assigned agent exists" and surfaces the agent's
  // userId (the task assignee). Agents with a NULL user_id are excluded by the
  // isNotNull filter — there's no user to assign the task to.
  const members = await tx
    .select({
      contactId: contactsTable.id,
      agentId: agentsTable.id,
      agentUserId: agentsTable.userId,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
    })
    .from(contactsTable)
    .innerJoin(agentsTable, eq(contactsTable.assignedAgentId, agentsTable.id))
    .where(
      and(
        eq(contactsTable.orgId, orgId),
        isNull(contactsTable.deletedAt),
        inArray(contactsTable.status, MEMBER_STATUSES),
        inArray(contactsTable.currentPlanType, [...MA_PLAN_TYPES]),
        isNotNull(agentsTable.userId),
      ),
    );

  let created = 0;
  let skipped = 0;

  for (const m of members) {
    const trigger = aepRenewalTrigger(year, m.contactId);

    // Idempotency guard: skip if this season's task already exists. The
    // surrounding advisory lock makes this check-then-insert race-free.
    const [existing] = await tx
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgId),
          eq(taskInstancesTable.autoAssignTrigger, trigger),
        ),
      )
      .limit(1);

    if (existing) {
      skipped++;
      continue;
    }

    await tx.insert(taskInstancesTable).values({
      id: randomUUID(),
      orgId,
      contactId: m.contactId,
      agentId: m.agentId,
      assignedToUserId: m.agentUserId,
      title:
        "Annual review — set AEP appointment before Oct 1 (plan renews 1/1)",
      description:
        `Set the annual review appointment for ${m.firstName} ${m.lastName} ` +
        `before Oct 1, when ${year + 1} plan details become available. ` +
        `Their Medicare Advantage plan renews January 1 — book the review now ` +
        `so the renewal doesn't slip through AEP (Oct 15–Dec 7).`,
      dueDate: dueAt,
      status: "open",
      priority: "high",
      createdBy: "system",
      autoAssignTrigger: trigger,
    });

    created++;
  }

  return { created, skipped };
}
