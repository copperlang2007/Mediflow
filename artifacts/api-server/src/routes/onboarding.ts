/**
 * Agent-onboarding + carrier-contracting backend routes.
 *
 * Skeleton + happy-path routes for Days 1-2. Endpoints that need
 * carrier paperwork, Dropbox Sign, or appointment-desk email-out are
 * stubbed with 501 + a TODO marker so Days 3+ have a clear hand-off.
 *
 * Defense-in-depth:
 *   - Every UPDATE/DELETE WHERE clause is org-scoped (`eq(orgId, authReq.orgId)`).
 *   - SSN + EIN are AES-256-GCM-encrypted before write via lib/encryption/pii.ts.
 *   - SSN/EIN/DOB are masked in responses for non-privileged roles.
 *   - Zod validates every body — no raw req.body reads.
 *   - Audit-log integration via auditMiddleware("agent_onboarding", ...) +
 *     auditMiddleware("carrier_contracting", ...).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  db,
  agentsTable,
  carriersTable,
  agentOnboardingRunsTable,
  agentContractingProfilesTable,
  carrierContractingRequestsTable,
  taskInstancesTable,
  documentsTable,
  notificationsTable,
  encryptSsn,
  decryptSsn,
  encryptEin,
  decryptEin,
  hashSsn,
  type Agent,
  type AgentContractingProfile,
  type AgentOnboardingRun,
  type CarrierContractingRequest,
} from "@workspace/db";
import {
  createCompleteProfileTask,
  createAdminReviewTask,
  createCarrierSignTask,
  closeContractingTask,
  completeProfileTaskKey,
  adminReviewTaskKey,
  poaDecisionTaskKey,
  adminOptOutTrackTaskKey,
  agentDisplayName,
} from "../workers/contractingTasks";
import { buildDummyTemplate, fillTemplateFromBytes } from "../lib/contractingPdf/pdfFiller";
import {
  generatePoaPdf,
  readPoaConfig,
} from "../lib/contractingPdf/poaTemplate";
import { getEsignStorage } from "../lib/esign/mediflowProvider";
import { getEsignProvider } from "../lib/esign/factory";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import {
  requireAuth,
  requirePermission,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { PHI_PRIVILEGED_ROLES, type Role } from "../lib/permissions";
import {
  canTransitionOnboarding,
  canTransitionContracting,
  isOnboardingStatus,
  isContractingStatus,
  ONBOARDING_STATUSES,
  ONBOARDING_STEP_ON_ENTER,
  type ContractingStatus,
  type OnboardingStatus,
} from "../workers/contractingStateMachine";

// Roles that see SSN/EIN/DOB in plaintext. The canonical set lives in
// `../lib/permissions` (PHI_PRIVILEGED_ROLES) — the design partner expects
// identical handling for contracting PII as for contact PHI, so both
// routes import the same set.

const MASKED_SSN = "***-**-****";
const MASKED_EIN = "**-*******";

const router: IRouter = Router();

router.use(
  scopeToRouter(router, auditMiddleware("agent_onboarding", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.agentId;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  })),
);

// ---- Helpers ---------------------------------------------------------------

/**
 * Serialize an agent_contracting_profiles row for an API response.
 *
 * - Drops the bytea columns (`ssnEncrypted`, `ssnHash`, `businessEinEncrypted`).
 * - Privileged roles see the decrypted SSN/EIN and the raw DOB.
 * - Everyone else sees fixed masked sentinels.
 */
function serializeProfile(
  profile: AgentContractingProfile,
  userRole: string,
): Omit<
  AgentContractingProfile,
  "ssnEncrypted" | "ssnHash" | "businessEinEncrypted"
> & {
  ssn: string | null;
  ein: string | null;
} {
  const {
    ssnEncrypted,
    ssnHash: _hash,
    businessEinEncrypted,
    ...rest
  } = profile;
  const privileged = PHI_PRIVILEGED_ROLES.has(userRole as Role);

  let ssn: string | null = null;
  if (ssnEncrypted != null) {
    ssn = privileged ? formatSsn(decryptSsn(ssnEncrypted as Buffer | Uint8Array)) : MASKED_SSN;
  }
  let ein: string | null = null;
  if (businessEinEncrypted != null) {
    ein = privileged
      ? formatEin(decryptEin(businessEinEncrypted as Buffer | Uint8Array))
      : MASKED_EIN;
  }

  return {
    ...rest,
    ssn,
    ein,
    dob: privileged ? (rest.dob ?? null) : null,
  };
}

function formatSsn(digits: string): string {
  return digits.length === 9
    ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
    : digits;
}

function formatEin(digits: string): string {
  return digits.length === 9
    ? `${digits.slice(0, 2)}-${digits.slice(2)}`
    : digits;
}

async function ensureAgentInOrg(
  agentId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Org-scoped lookup of the columns the contracting orchestration cares
 * about — agent's linked user (for task assignment) and first/last name
 * (for task titles). Returns null if the agent isn't in the org so
 * callers can 404 consistently.
 */
async function loadAgentForOrchestration(
  agentId: string,
  orgId: string,
): Promise<Pick<Agent, "id" | "orgId" | "userId" | "firstName" | "lastName"> | null> {
  const [row] = await db
    .select({
      id: agentsTable.id,
      orgId: agentsTable.orgId,
      userId: agentsTable.userId,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
    })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

async function loadActiveOnboarding(
  agentId: string,
  orgId: string,
): Promise<AgentOnboardingRun | null> {
  const [run] = await db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.agentId, agentId),
        eq(agentOnboardingRunsTable.orgId, orgId),
        sql`${agentOnboardingRunsTable.status} != 'cancelled'`,
      ),
    )
    .limit(1);
  return run ?? null;
}

/**
 * Apply an onboarding status transition with state-machine validation.
 * Returns the updated row, or null if the row could not be found in the org.
 * Throws on a forbidden transition (caller maps to 409).
 */
async function transitionOnboarding(
  runId: string,
  orgId: string,
  next: OnboardingStatus,
): Promise<AgentOnboardingRun | null> {
  const [current] = await db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.id, runId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .limit(1);

  if (!current) return null;

  const currentStatus = current.status as OnboardingStatus;
  if (!canTransitionOnboarding(currentStatus, next)) {
    throw new ForbiddenTransitionError(currentStatus, next);
  }

  if (currentStatus === next) return current;

  const completedSteps =
    typeof current.completedSteps === "object" && current.completedSteps !== null
      ? { ...(current.completedSteps as Record<string, unknown>) }
      : {};
  const stepKey = ONBOARDING_STEP_ON_ENTER[next];
  if (stepKey) completedSteps[stepKey] = true;

  const [updated] = await db
    .update(agentOnboardingRunsTable)
    .set({
      status: next,
      completedSteps,
      completedAt: next === "complete" ? new Date() : current.completedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentOnboardingRunsTable.id, runId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .returning();
  return updated ?? null;
}

class ForbiddenTransitionError extends Error {
  constructor(public from: string, public to: string) {
    super(`Forbidden onboarding transition: ${from} -> ${to}`);
    this.name = "ForbiddenTransitionError";
  }
}

// ---- Zod schemas -----------------------------------------------------------

const StartOnboardingSchema = z.object({
  agentId: z.string().min(1),
});

const SsnSchema = z
  .string()
  .min(1)
  .refine((v) => v.replace(/\D/g, "").length === 9, {
    message: "SSN must contain exactly 9 digits",
  });

const EinSchema = z
  .string()
  .min(1)
  .refine((v) => v.replace(/\D/g, "").length === 9, {
    message: "EIN must contain exactly 9 digits",
  });

const ProfilePatchSchema = z.object({
  ssn: SsnSchema.nullable().optional(),
  dob: z.string().date().nullable().optional(),
  homeAddressLine1: z.string().max(200).nullable().optional(),
  homeAddressLine2: z.string().max(200).nullable().optional(),
  homeCity: z.string().max(100).nullable().optional(),
  homeState: z.string().length(2).nullable().optional(),
  homeZip: z.string().max(10).nullable().optional(),
  mailingSameAsHome: z.boolean().optional(),
  mailingAddressLine1: z.string().max(200).nullable().optional(),
  mailingAddressLine2: z.string().max(200).nullable().optional(),
  mailingCity: z.string().max(100).nullable().optional(),
  mailingState: z.string().length(2).nullable().optional(),
  mailingZip: z.string().max(10).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().nullable().optional(),
  entityType: z
    .enum(["individual", "llc", "corp", "partnership"])
    .nullable()
    .optional(),
  businessName: z.string().max(200).nullable().optional(),
  businessEin: EinSchema.nullable().optional(),
  eAndOCarrier: z.string().max(200).nullable().optional(),
  eAndOPolicyNumber: z.string().max(100).nullable().optional(),
  eAndOExpiresOn: z.string().date().nullable().optional(),
});

const StateCodeSchema = z.string().length(2);
const CarrierSelectionsSchema = z.object({
  selections: z
    .array(
      z.object({
        carrierId: z.string().min(1),
        states: z.array(StateCodeSchema).min(1).max(56),
      }),
    )
    .min(1)
    .max(50),
});

const ListOnboardingsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

// ---- Routes ----------------------------------------------------------------

/**
 * POST /onboarding/start
 *
 * Admin starts (or invites) an onboarding run for an existing agent.
 * Idempotent on `(org_id, agent_id)` partial-unique index — re-posting
 * returns the existing run instead of erroring.
 */
router.post(
  "/onboarding/start",
  requireAuth,
  requirePermission("agent", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = StartOnboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const { agentId } = parsed.data;

    const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Idempotency — return the existing active run rather than 409'ing.
    const existing = await loadActiveOnboarding(agentId, authReq.orgId);
    if (existing) {
      const [profile] = await db
        .select()
        .from(agentContractingProfilesTable)
        .where(
          and(
            eq(agentContractingProfilesTable.agentId, agentId),
            eq(agentContractingProfilesTable.orgId, authReq.orgId),
          ),
        )
        .limit(1);
      // Idempotency for the task too: createCompleteProfileTask is keyed
      // by run.id, so re-calling /onboarding/start returns the existing
      // run + the existing task (or upserts if a prior call somehow
      // skipped task creation — i.e. a Day-1/2 run that pre-existed this
      // PR's task wiring).
      await createCompleteProfileTask(existing, agent);
      res.status(200).json({
        run: existing,
        profile: profile ? serializeProfile(profile, authReq.userRole) : null,
        idempotent: true,
      });
      return;
    }

    const runId = randomUUID();
    const [run] = await db
      .insert(agentOnboardingRunsTable)
      .values({
        id: runId,
        orgId: authReq.orgId,
        agentId,
        startedByUserId: authReq.userId,
        status: "draft",
      })
      .returning();

    // Create an empty profile row in lockstep so the agent has something to
    // PATCH into. Org-scoped UPSERT — if a stale profile exists from a
    // cancelled prior run we keep its data; otherwise insert a blank row.
    await db
      .insert(agentContractingProfilesTable)
      .values({
        agentId,
        orgId: authReq.orgId,
      })
      .onConflictDoNothing({ target: agentContractingProfilesTable.agentId });

    const [profile] = await db
      .select()
      .from(agentContractingProfilesTable)
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, agentId),
          eq(agentContractingProfilesTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    // Agent-facing task — "fill out your contracting profile". Assigned
    // to the agent's linked user when present (`agents.user_id`). The
    // task is keyed on `${run.id}:complete-profile`, so any retry of
    // /onboarding/start (network blip, double-click) collapses to a
    // no-op via the contracting_task_key partial unique index.
    await createCompleteProfileTask(run, agent);

    res.status(201).json({
      run,
      profile: profile ? serializeProfile(profile, authReq.userRole) : null,
      idempotent: false,
    });
  },
);

/**
 * GET /onboarding/:agentId
 *
 * Current state of the onboarding run + profile + carrier requests.
 */
router.get(
  "/onboarding/:agentId",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    if (!(await ensureAgentInOrg(agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    const [profile] = await db
      .select()
      .from(agentContractingProfilesTable)
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, agentId),
          eq(agentContractingProfilesTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    const carrierRequests = await db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.onboardingRunId, run.id),
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
        ),
      );

    res.json({
      run,
      profile: profile ? serializeProfile(profile, authReq.userRole) : null,
      carrierRequests,
    });
  },
);

/**
 * PATCH /onboarding/:agentId/profile
 *
 * Agent (or admin on behalf of) updates the contracting profile. SSN + EIN
 * go through AES-256-GCM before write; the plaintext never lands in the
 * database. Auto-advances the run from `draft` → `profile_in_progress` so
 * the wizard always reflects progress.
 */
router.patch(
  "/onboarding/:agentId/profile",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    if (!(await ensureAgentInOrg(agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    const parsed = ProfilePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const d = parsed.data;

    // Build an UPDATE patch — only set fields the caller explicitly included.
    // `null` is "clear it"; `undefined` is "leave alone".
    const updates: Partial<typeof agentContractingProfilesTable.$inferInsert> = {};

    if (d.ssn !== undefined) {
      if (d.ssn === null) {
        updates.ssnEncrypted = null;
        updates.ssnHash = null;
      } else {
        const { encrypted, hash } = encryptSsn(d.ssn);
        updates.ssnEncrypted = encrypted;
        updates.ssnHash = hash;
      }
    }
    if (d.businessEin !== undefined) {
      if (d.businessEin === null) {
        updates.businessEinEncrypted = null;
      } else {
        const { encrypted } = encryptEin(d.businessEin);
        updates.businessEinEncrypted = encrypted;
      }
    }

    if (d.dob !== undefined) updates.dob = d.dob;
    if (d.homeAddressLine1 !== undefined)
      updates.homeAddressLine1 = d.homeAddressLine1;
    if (d.homeAddressLine2 !== undefined)
      updates.homeAddressLine2 = d.homeAddressLine2;
    if (d.homeCity !== undefined) updates.homeCity = d.homeCity;
    if (d.homeState !== undefined) updates.homeState = d.homeState;
    if (d.homeZip !== undefined) updates.homeZip = d.homeZip;
    if (d.mailingSameAsHome !== undefined)
      updates.mailingSameAsHome = d.mailingSameAsHome;
    if (d.mailingAddressLine1 !== undefined)
      updates.mailingAddressLine1 = d.mailingAddressLine1;
    if (d.mailingAddressLine2 !== undefined)
      updates.mailingAddressLine2 = d.mailingAddressLine2;
    if (d.mailingCity !== undefined) updates.mailingCity = d.mailingCity;
    if (d.mailingState !== undefined) updates.mailingState = d.mailingState;
    if (d.mailingZip !== undefined) updates.mailingZip = d.mailingZip;
    if (d.phone !== undefined) updates.phone = d.phone;
    if (d.email !== undefined) updates.email = d.email;
    if (d.entityType !== undefined) updates.entityType = d.entityType;
    if (d.businessName !== undefined) updates.businessName = d.businessName;
    if (d.eAndOCarrier !== undefined) updates.eAndOCarrier = d.eAndOCarrier;
    if (d.eAndOPolicyNumber !== undefined)
      updates.eAndOPolicyNumber = d.eAndOPolicyNumber;
    if (d.eAndOExpiresOn !== undefined)
      updates.eAndOExpiresOn = d.eAndOExpiresOn;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(agentContractingProfilesTable)
      .set(updates)
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, agentId),
          eq(agentContractingProfilesTable.orgId, authReq.orgId),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Auto-advance: any data on the profile means we're past `draft`.
    if (run.status === "draft") {
      try {
        await transitionOnboarding(
          run.id,
          authReq.orgId,
          "profile_in_progress",
        );
      } catch {
        // Best-effort — if the transition is forbidden, log nothing and
        // proceed; the profile update itself already succeeded.
      }
    }

    res.json({ profile: serializeProfile(updated, authReq.userRole) });
  },
);

/**
 * POST /onboarding/:agentId/carriers/select
 *
 * Body: `{ selections: [{ carrierId, states: ["FL","GA",...] }] }`.
 * Creates one `carrier_contracting_requests` row per selection, in
 * `draft` state. Org-scoped agent + carrier validation. Advances the run
 * to `carriers_selected`.
 */
router.post(
  "/onboarding/:agentId/carriers/select",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    if (!(await ensureAgentInOrg(agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    const parsed = CarrierSelectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const { selections } = parsed.data;

    // Validate every carrierId is org-scoped and active in a single query.
    const carrierIds = [...new Set(selections.map((s) => s.carrierId))];
    const carrierRows: Array<{ id: string; isActive: boolean }> = await db
      .select({ id: carriersTable.id, isActive: carriersTable.isActive })
      .from(carriersTable)
      .where(eq(carriersTable.orgId, authReq.orgId));
    const validIds = new Set(
      carrierRows.filter((c) => c.isActive).map((c) => c.id),
    );
    const invalid = carrierIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      res.status(400).json({
        error: "One or more carrierId values are not valid for this org",
        invalidCarrierIds: invalid,
      });
      return;
    }

    // Normalize state codes (uppercase, no dupes).
    const normalized = selections.map((s) => ({
      carrierId: s.carrierId,
      states: [...new Set(s.states.map((st) => st.toUpperCase()))],
    }));

    const inserted: CarrierContractingRequest[] = [];
    for (const sel of normalized) {
      try {
        const [row] = await db
          .insert(carrierContractingRequestsTable)
          .values({
            id: randomUUID(),
            orgId: authReq.orgId,
            onboardingRunId: run.id,
            agentId,
            carrierId: sel.carrierId,
            states: sel.states,
            status: "draft",
          })
          .returning();
        if (row) inserted.push(row);
      } catch (err) {
        // Likely the partial-unique on (org, agent, carrier) collided —
        // re-amend the existing active row's states list instead.
        const [existing] = await db
          .update(carrierContractingRequestsTable)
          .set({
            states: sel.states,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(carrierContractingRequestsTable.orgId, authReq.orgId),
              eq(carrierContractingRequestsTable.agentId, agentId),
              eq(carrierContractingRequestsTable.carrierId, sel.carrierId),
              sql`${carrierContractingRequestsTable.status} != 'cancelled'`,
            ),
          )
          .returning();
        if (existing) inserted.push(existing);
        else {
          req.log?.warn(
            { err, carrierId: sel.carrierId },
            "carrier selection upsert failed",
          );
        }
      }
    }

    let advanced: AgentOnboardingRun | null = null;
    try {
      advanced = await transitionOnboarding(
        run.id,
        authReq.orgId,
        "carriers_selected",
      );
    } catch {
      // Forbidden transition (e.g. caller selected carriers from a state
      // already past carriers_selected) — keep the inserts but skip the
      // status bump rather than rolling back.
    }

    // On reaching `carriers_selected` for the first time the orchestration
    // hands off from the agent (who finished selecting) to the admin (who
    // reviews + fires `request-contracting`):
    //   - close the agent's complete-profile task
    //   - create the admin review task assigned to whoever started the run
    // The dedup key on the admin task makes this idempotent against
    // duplicate /carriers/select calls.
    if (advanced && advanced.status === "carriers_selected") {
      const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
      if (agent) {
        await closeContractingTask(
          authReq.orgId,
          completeProfileTaskKey(run.id),
        );
        await createAdminReviewTask(
          advanced,
          agent,
          advanced.startedByUserId ?? null,
        );
      }
    }

    res.status(201).json({ carrierRequests: inserted });
  },
);

/**
 * POST /onboarding/:agentId/cancel
 *
 * Sets the active run to `cancelled`. The partial-unique index then
 * permits a fresh `/start` call for the same agent.
 */
router.post(
  "/onboarding/:agentId/cancel",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    if (!(await ensureAgentInOrg(agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    try {
      const updated = await transitionOnboarding(
        run.id,
        authReq.orgId,
        "cancelled",
      );
      if (!updated) {
        res.status(404).json({ error: "Onboarding run not found" });
        return;
      }
      res.json({ run: updated });
    } catch (err) {
      if (err instanceof ForbiddenTransitionError) {
        res.status(409).json({
          error: "Cannot cancel — invalid state transition",
          from: err.from,
          to: err.to,
        });
        return;
      }
      throw err;
    }
  },
);

/**
 * GET /onboarding  (admin only)
 *
 * Paginated list of all onboarding runs in the caller's org. Mirrors the
 * `{ data, total, limit, offset }` envelope established by PR #70 for
 * admin-facing list endpoints.
 */
router.get(
  "/onboarding",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = ListOnboardingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query",
        details: parsed.error.issues,
      });
      return;
    }
    const { status, limit, offset } = parsed.data;
    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

    const conditions: SQL[] = [eq(agentOnboardingRunsTable.orgId, authReq.orgId)];
    if (status && isOnboardingStatus(status)) {
      conditions.push(eq(agentOnboardingRunsTable.status, status));
    }

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(agentOnboardingRunsTable)
        .where(and(...conditions))
        .orderBy(sql`${agentOnboardingRunsTable.startedAt} DESC`)
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(agentOnboardingRunsTable)
        .where(and(...conditions)),
    ]);

    res.json({
      data: rows,
      total: Number(totalRows[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  },
);

// ---- Helpers for Day-3 contracting orchestration ---------------------------

/**
 * Generate a placeholder PDF for a carrier_contracting_request and persist
 * a `documents` row pointing at a synthetic storage key.
 *
 * ARCHITECTURE NOTE: this per-carrier paperwork generation is a placeholder
 * path retained for the current e-sign flow shape. The wider plan replaces
 * it with a single Power-of-Attorney signing per onboarding run (see issue
 * #90's INSUREitALL feature plan). Per-carrier signing tasks are still
 * created today; a future PR will replace them with a single POA signing
 * + admin-handled carrier submission.
 *
 * The dummy template from `pdfFiller.buildDummyTemplate()` is filled with
 * the agent's name + a generated request id. Generic 1-page PDF — same
 * shape Day 3 had before the per-carrier scaffolding was attempted.
 *
 * Idempotent: callers gate on `request.status === 'draft'`, so a second
 * `request-contracting` call on an already-paperwork-generated request
 * never lands here.
 */
async function generatePlaceholderPaperwork(
  orgId: string,
  agentName: string,
  carrierName: string,
  requestId: string,
  uploadedByUserId: string | null,
): Promise<string> {
  const template = await buildDummyTemplate();
  // The dummy template ships two text fields and a checkbox. The wider
  // plan replaces this with a single POA PDF (see issue #90); for now
  // we just prove the plumbing executes.
  await fillTemplateFromBytes(
    template,
    {
      fullName: agentName,
      ssn: "(see encrypted profile)",
      consent: true,
    },
    { flatten: true },
  );

  // Synthetic storage key — contracting PDFs aren't yet wired to object
  // storage. The `documents` row exists so the foreign key on
  // `carrier_contracting_requests.paperwork_document_id` is satisfied
  // and admin UIs can show "paperwork generated".
  const docId = randomUUID();
  const storageKey = `contracting/${orgId}/${requestId}/placeholder.pdf`;
  await db.insert(documentsTable).values({
    id: docId,
    orgId,
    name: `${carrierName} contracting packet (placeholder)`,
    category: "contracting",
    storageKey,
    mimeType: "application/pdf",
    uploadedBy: uploadedByUserId,
  });
  return docId;
}

/**
 * Apply a contracting-request status transition with state-machine
 * validation. Mirrors `transitionOnboarding` for the per-carrier sub-flow.
 * Returns the updated row, or null if no matching org-scoped row exists.
 * Throws `ForbiddenContractingTransitionError` on a forbidden transition.
 */
async function transitionContractingRequest(
  requestId: string,
  orgId: string,
  next: ContractingStatus,
  extra: Partial<typeof carrierContractingRequestsTable.$inferInsert> = {},
): Promise<CarrierContractingRequest | null> {
  const [current] = await db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.id, requestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!current) return null;

  const currentStatus = current.status as ContractingStatus;
  if (!canTransitionContracting(currentStatus, next)) {
    throw new ForbiddenContractingTransitionError(currentStatus, next);
  }
  if (currentStatus === next && Object.keys(extra).length === 0) return current;

  const [updated] = await db
    .update(carrierContractingRequestsTable)
    .set({
      status: next,
      lastStatusChangeAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    })
    .where(
      and(
        eq(carrierContractingRequestsTable.id, requestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
      ),
    )
    .returning();
  return updated ?? null;
}

class ForbiddenContractingTransitionError extends Error {
  constructor(public from: string, public to: string) {
    super(`Forbidden contracting transition: ${from} -> ${to}`);
    this.name = "ForbiddenContractingTransitionError";
  }
}

/**
 * Resolve the contracting status the admin PATCH should land on.
 *
 * Phase 1.5: an implicit transition (writing-number entered without an
 * explicit `status`) defaults to `appointed` — terminal. The transitions
 * to `submitted` are only valid from `signed`, `awaiting_admin_submission`,
 * or `invite_requested`; the caller MUST set status explicitly when
 * advancing a request through those mid-states.
 */

/**
 * Inspect every carrier_contracting_request on the run and roll the
 * onboarding_run status forward if the aggregate state warrants it:
 *
 *   - all requests in `submitted` (or beyond) → run → `submitted`
 *   - all requests in `appointed`             → run → `complete`,
 *                                               admin tasks closed,
 *                                               notification row written
 *
 * Called from:
 *   - `POST /carriers/:carrierId/sign` (advances individual requests)
 *   - `POST /carriers/:carrierId/submit` (Day 6 — also calls this)
 *   - admin status override + Day-6 worker that records carrier
 *     appointment decisions
 *
 * Designed to be called multiple times: every advance is gated by the
 * state machine, so a no-op call (e.g. run already complete) is safe.
 */
async function maybeAdvanceRunForRequests(runId: string, orgId: string): Promise<void> {
  const [run] = await db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.id, runId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!run) return;

  const requests = await db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.onboardingRunId, runId),
        eq(carrierContractingRequestsTable.orgId, orgId),
        sql`${carrierContractingRequestsTable.status} != 'cancelled'`,
      ),
    );
  if (requests.length === 0) return;

  const allSubmitted = requests.every((r) =>
    ["submitted", "under_review", "appointed", "rejected"].includes(r.status),
  );
  const allAppointed = requests.every((r) => r.status === "appointed");

  if (allAppointed && run.status !== "complete") {
    try {
      // Walk: signing -> submitted -> complete OR submitted -> complete.
      // The state machine forbids skipping; call transitionOnboarding
      // sequentially and rely on the same-status no-op return for already-
      // submitted runs.
      if (run.status === "signing") {
        await transitionOnboarding(run.id, orgId, "submitted");
      }
      await transitionOnboarding(run.id, orgId, "complete");
    } catch {
      // Forbidden — the run is in a terminal state we can't move out of.
      return;
    }

    // Close any outstanding admin tasks for the run.
    await closeContractingTask(orgId, adminReviewTaskKey(run.id));

    // Write a single notification row for the admin who started the run.
    // resourceId is the agent id (not the run id) because the destination
    // page `/admin-onboarding/:agentId` is keyed by agent — this lets the
    // notification panel deep-link straight to the run's detail view.
    if (run.startedByUserId) {
      await db.insert(notificationsTable).values({
        id: randomUUID(),
        orgId,
        userId: run.startedByUserId,
        type: "onboarding_complete",
        title: "Agent onboarding complete",
        body: "All carrier appointments have been recorded — the agent is fully onboarded.",
        priority: "normal",
        resourceType: "agent_onboarding",
        resourceId: run.agentId,
      });
    }
    return;
  }

  if (allSubmitted && run.status === "signing") {
    try {
      await transitionOnboarding(run.id, orgId, "submitted");
    } catch {
      // Forbidden — leave as-is.
    }
  }
}

// ---- Phase 1.5 POA path ----------------------------------------------------

/**
 * POST /onboarding/:agentId/poa-decision
 *
 * Phase 1.5 — replaces the per-carrier paperwork-generation + sign loop with
 * a single Power-of-Attorney decision:
 *
 *   - `{ accepted: true }`  → generate the POA PDF, create an e-sign
 *     envelope linked to the onboarding run, mark
 *     `agent_onboarding_runs.poa_status = pending`. Return the signing
 *     URL so the wizard can hop into `/sign/:envelopeId`. The
 *     `carrier_contracting_request` rows stay in `draft` until the agent
 *     signs the envelope (then `completePoaSigningTransition` flips
 *     them to `awaiting_admin_submission`).
 *
 *   - `{ accepted: false }` → mark `poa_status = opted_out`, transition
 *     every draft carrier request to `invite_requested`, enqueue the
 *     submit-packet worker for each (repurposed: it now emails the
 *     "please send the agent a contracting invite" request), and create
 *     a single admin task to track the agent's manual carrier completions.
 *
 * Permission: the owning agent OR an admin / compliance manager.
 * Idempotent: re-posting with the same body collapses to a no-op + returns
 * the existing envelope (accept) or `{ poaStatus }` (decline).
 */
const PoaDecisionSchema = z.object({
  accepted: z.boolean(),
});

router.post(
  "/onboarding/:agentId/poa-decision",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    const parsed = PoaDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const { accepted } = parsed.data;

    const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Permission narrowing — the agent themselves OR an admin.
    const isAdmin =
      authReq.userRole === "super_admin" ||
      authReq.userRole === "agency_admin" ||
      authReq.userRole === "compliance_manager";
    const isOwningAgent =
      authReq.userRole === "agent" && agent.userId === authReq.userId;
    if (!isAdmin && !isOwningAgent) {
      res.status(403).json({
        error: "Only the agent themselves or an admin can record the POA decision",
      });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    // Re-call idempotency. If the run has already been processed via the
    // POA path, return the same shape rather than re-doing the work.
    if (run.poaStatus === "signed") {
      res.status(200).json({
        poaStatus: run.poaStatus,
        envelopeId: run.poaEnvelopeId,
        idempotent: true,
      });
      return;
    }
    if (run.poaStatus === "opted_out") {
      if (accepted) {
        // The agent flipped from opt-out → accept. Currently NOT supported
        // — they need an admin to cancel + restart the run. Return 409 so
        // the wizard surfaces a clear message.
        res.status(409).json({
          error:
            "Run is already in the opt-out path; cannot switch to POA without cancelling and restarting onboarding",
          poaStatus: run.poaStatus,
        });
        return;
      }
      res.status(200).json({ poaStatus: run.poaStatus, idempotent: true });
      return;
    }
    if (run.poaStatus === "pending" && accepted && run.poaEnvelopeId) {
      // Existing envelope — return its metadata for a re-call.
      res.status(200).json({
        poaStatus: run.poaStatus,
        envelopeId: run.poaEnvelopeId,
        signingUrl: `/sign/${run.poaEnvelopeId}`,
        idempotent: true,
      });
      return;
    }

    // Load the carriers selected for this run so the POA body can list
    // them by name. Empty selection blocks the accept path — a POA with
    // no carriers is meaningless.
    const carrierRequests = await db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.onboardingRunId, run.id),
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
          sql`${carrierContractingRequestsTable.status} != 'cancelled'`,
        ),
      );
    if (carrierRequests.length === 0) {
      res.status(409).json({
        error:
          "No carriers selected on this run yet — call /carriers/select first",
      });
      return;
    }

    if (!accepted) {
      return handlePoaDecline(req, res, authReq, run, agent, carrierRequests);
    }
    return handlePoaAccept(req, res, authReq, run, agent, carrierRequests);
  },
);

async function handlePoaAccept(
  req: Request,
  res: Response,
  authReq: AuthenticatedRequest,
  run: AgentOnboardingRun,
  agent: Pick<Agent, "id" | "orgId" | "userId" | "firstName" | "lastName">,
  carrierRequests: CarrierContractingRequest[],
): Promise<void> {
  if (!agent.userId) {
    res.status(409).json({
      error:
        "Agent has no linked user account — cannot create signing envelope",
    });
    return;
  }

  const carrierRows = await db
    .select({ id: carriersTable.id, name: carriersTable.name })
    .from(carriersTable)
    .where(eq(carriersTable.orgId, authReq.orgId));
  const nameById = new Map(carrierRows.map((c) => [c.id, c.name]));
  const carrierNames = carrierRequests.map(
    (r) => nameById.get(r.carrierId) ?? "(unknown carrier)",
  );

  // Pull the agent profile for address + email. The address goes into the
  // POA body so the printed-name + address block reads correctly; the
  // email is the e-sign signer email.
  const [profile] = await db
    .select()
    .from(agentContractingProfilesTable)
    .where(
      and(
        eq(agentContractingProfilesTable.agentId, agent.id),
        eq(agentContractingProfilesTable.orgId, authReq.orgId),
      ),
    )
    .limit(1);

  const addressParts = [
    profile?.homeAddressLine1,
    profile?.homeAddressLine2,
    profile?.homeCity,
    profile?.homeState,
    profile?.homeZip,
  ].filter((v): v is string => Boolean(v && v.trim()));
  const agentAddress =
    addressParts.length > 0
      ? addressParts.join(", ")
      : "(address not on file)";

  // Pull the agent's NPN + email from the agents table (fallback to
  // profile email if the agent row's email is empty — unlikely but
  // defensive).
  const [agentRow] = await db
    .select({ npn: agentsTable.npn, email: agentsTable.email })
    .from(agentsTable)
    .where(eq(agentsTable.id, agent.id))
    .limit(1);
  const signerEmail = profile?.email ?? agentRow?.email ?? "unknown@example.com";

  const { daysToExpire, granteeName } = readPoaConfig();
  const effectiveDate = new Date();
  const expiryDate = new Date(
    Date.now() + daysToExpire * 24 * 60 * 60 * 1000,
  );

  // Collect the union of state codes across all selected carriers so the
  // POA's "licensed states" block is informational + accurate.
  const stateUnion = new Set<string>();
  for (const r of carrierRequests) {
    for (const s of r.states ?? []) stateUnion.add(s);
  }

  const pdfBuffer = await generatePoaPdf({
    agentFullName: agentDisplayName(agent),
    agentNpn: agentRow?.npn ?? null,
    agentAddress,
    agentLicenseStates: [...stateUnion].sort(),
    carrierNames,
    effectiveDate,
    expiryDate,
    granteeName,
  });

  // Upload the unsigned POA + create a documents row so the e-sign
  // provider can locate the bytes when the agent signs.
  const storage = getEsignStorage();
  const filename = `poa-${run.id}.pdf`;
  const storageKey = await storage.uploadPdf(pdfBuffer, filename, authReq.orgId);
  const docId = randomUUID();
  await db.insert(documentsTable).values({
    id: docId,
    orgId: authReq.orgId,
    name: `Power of Attorney — ${agentDisplayName(agent)} (DRAFT PLACEHOLDER)`,
    category: "contracting",
    storageKey,
    mimeType: "application/pdf",
    fileSizeBytes: pdfBuffer.byteLength,
    uploadedBy: authReq.userId,
  });

  // Create the envelope. The POA-flow branch in createEnvelope links it
  // to the onboarding run rather than a single carrier request.
  const envelope = await getEsignProvider().createEnvelope({
    orgId: authReq.orgId,
    onboardingRunId: run.id,
    pdfDocumentId: docId,
    signers: [
      {
        userId: agent.userId,
        displayName: agentDisplayName(agent),
        email: signerEmail,
      },
    ],
    createdByUserId: authReq.userId,
    ipAddress: req.ip ?? null,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : null,
  });

  await db
    .update(agentOnboardingRunsTable)
    .set({
      poaStatus: "pending",
      poaEnvelopeId: envelope.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentOnboardingRunsTable.id, run.id),
        eq(agentOnboardingRunsTable.orgId, authReq.orgId),
      ),
    );

  res.status(200).json({
    poaStatus: "pending",
    envelopeId: envelope.id,
    signingUrl: `/sign/${envelope.id}`,
    idempotent: false,
  });
}

async function handlePoaDecline(
  _req: Request,
  res: Response,
  authReq: AuthenticatedRequest,
  run: AgentOnboardingRun,
  agent: Pick<Agent, "id" | "orgId" | "userId" | "firstName" | "lastName">,
  carrierRequests: CarrierContractingRequest[],
): Promise<void> {
  // Flip the run + transition every draft carrier request → invite_requested.
  await db
    .update(agentOnboardingRunsTable)
    .set({
      poaStatus: "opted_out",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentOnboardingRunsTable.id, run.id),
        eq(agentOnboardingRunsTable.orgId, authReq.orgId),
      ),
    );

  let transitioned = 0;
  for (const r of carrierRequests) {
    if (r.status !== "draft") continue;
    const now = new Date();
    const [updated] = await db
      .update(carrierContractingRequestsTable)
      .set({
        status: "invite_requested",
        lastStatusChangeAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(carrierContractingRequestsTable.id, r.id),
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
          eq(carrierContractingRequestsTable.status, "draft"),
        ),
      )
      .returning();
    if (updated) {
      transitioned += 1;
      // Enqueue the submit worker for each — repurposed for the
      // invite-request email-out (see workers/submitContractingPacket.ts).
      await enqueue(
        JOB_NAMES.SUBMIT_CONTRACTING_PACKET,
        { carrierContractingRequestId: updated.id, orgId: authReq.orgId },
        { singletonKey: `invite:${updated.id}` },
      );
    }
  }

  // Advance the run: carriers_selected → signing (the agent has made
  // their authorization decision; system now waits on carriers). Wrapped
  // in try/catch — failure here doesn't undo the per-carrier transitions
  // above.
  try {
    await transitionOnboarding(run.id, authReq.orgId, "signing");
  } catch {
    /* forbidden transition — run was already past carriers_selected */
  }

  // Close the agent's "decide POA" task (if surfaced as a task) +
  // create the admin tracking task.
  await closeContractingTask(
    authReq.orgId,
    poaDecisionTaskKey(run.id),
  );

  await db
    .insert(taskInstancesTable)
    .values({
      id: randomUUID(),
      orgId: authReq.orgId,
      agentId: agent.id,
      title: `Track ${agentDisplayName(agent)}'s carrier completions (opt-out path)`,
      description:
        "The agent declined the Power of Attorney and will complete each carrier's contracting flow directly. Track completions here and mark each carrier 'submitted' once the agent confirms they've finished the carrier's web flow.",
      status: "open",
      priority: "medium",
      assignedToUserId: run.startedByUserId ?? null,
      createdBy: null,
      contractingTaskKey: adminOptOutTrackTaskKey(run.id),
    })
    .onConflictDoNothing({
      target: [
        taskInstancesTable.orgId,
        taskInstancesTable.contractingTaskKey,
      ],
      where: isNotNull(taskInstancesTable.contractingTaskKey),
    });

  res.status(200).json({
    poaStatus: "opted_out",
    transitioned,
    idempotent: false,
  });
}

// ---- Day-3 routes (deprecated by Phase 1.5 POA pivot) ---------------------

const RequestContractingSchema = z.object({}).strict().optional().or(z.undefined());

/**
 * POST /onboarding/:agentId/request-contracting (admin)
 *
 * Admin fires this after the agent finishes profile + carrier selection.
 * For every carrier_contracting_request in `draft`:
 *   - generate a placeholder PDF (Day 4 will swap real templates in here)
 *   - link the documents row via `paperwork_document_id`
 *   - transition the request to `paperwork_generated`
 *   - create the agent's "Sign contracting paperwork for {carrierName}" task
 * Then close the admin review task and roll the onboarding run forward
 * into `signing`.
 *
 * Idempotent: a second call only acts on requests still in `draft`; the
 * admin task close + run transition are gated by their own state checks
 * so duplicates collapse to a no-op.
 */
router.post(
  "/onboarding/:agentId/request-contracting",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);

    const parsed = RequestContractingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    // Phase 1.5 deprecation: per-carrier paperwork generation is replaced
    // by the run-wide POA decision. If the run has already gone down the
    // POA path (pending / signed / opted_out), refuse with a 410 + a
    // pointer to the new flow. Runs still in `not_applicable` are legacy
    // / in-flight and may continue.
    if (run.poaStatus !== "not_applicable") {
      res.status(410).json({
        error:
          "Per-carrier paperwork generation has been deprecated. This onboarding run uses the POA flow — call POST /onboarding/:agentId/poa-decision instead.",
        poaStatus: run.poaStatus,
        nextRoute: `/onboarding/${agentId}/poa-decision`,
      });
      return;
    }

    // Load every carrier_contracting_request for the run + the carrier
    // name in one go. We join in JS so the test harness (PGlite) doesn't
    // get tripped up by drizzle's join syntax variants.
    const requests = await db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.onboardingRunId, run.id),
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
        ),
      );

    if (requests.length === 0) {
      res.status(409).json({
        error:
          "No carrier requests on this run yet — call /carriers/select first",
      });
      return;
    }

    const carrierRows = await db
      .select({ id: carriersTable.id, name: carriersTable.name })
      .from(carriersTable)
      .where(eq(carriersTable.orgId, authReq.orgId));
    const carrierNameById = new Map(carrierRows.map((c) => [c.id, c.name]));

    const agentName = `${agent.firstName} ${agent.lastName}`.trim() || "agent";

    const advanced: CarrierContractingRequest[] = [];
    const signTasks: Array<{ requestId: string; taskId: string }> = [];
    for (const r of requests) {
      if (r.status !== "draft") {
        // Either already processed (paperwork_generated and beyond) or
        // cancelled. Re-call idempotency: skip — but we DON'T skip the
        // sign-task create below for `paperwork_generated` rows, in case
        // a prior call crashed between PDF gen and task create.
        if (r.status === "paperwork_generated") {
          const t = await createCarrierSignTask(
            run,
            r,
            carrierNameById.get(r.carrierId) ?? "the carrier",
            agent,
          );
          signTasks.push({ requestId: r.id, taskId: t.id });
        }
        continue;
      }

      const carrierName = carrierNameById.get(r.carrierId) ?? "the carrier";
      // ARCHITECTURE NOTE: this per-carrier paperwork generation is a placeholder
      // path retained for the current e-sign flow shape. The wider plan replaces
      // it with a single Power-of-Attorney signing per onboarding run (see issue
      // #90's INSUREitALL feature plan). Per-carrier signing tasks are still
      // created today; a future PR will replace them with a single POA signing
      // + admin-handled carrier submission.
      const docId = await generatePlaceholderPaperwork(
        authReq.orgId,
        agentName,
        carrierName,
        r.id,
        authReq.userId,
      );

      let updated: CarrierContractingRequest | null;
      try {
        updated = await transitionContractingRequest(
          r.id,
          authReq.orgId,
          "paperwork_generated",
          { paperworkDocumentId: docId },
        );
      } catch (err) {
        if (err instanceof ForbiddenContractingTransitionError) continue;
        throw err;
      }
      if (!updated) continue;
      advanced.push(updated);

      const t = await createCarrierSignTask(run, updated, carrierName, agent);
      signTasks.push({ requestId: updated.id, taskId: t.id });
    }

    // Close the admin review task — idempotent.
    await closeContractingTask(authReq.orgId, adminReviewTaskKey(run.id));

    // Run transition: carriers_selected → signing. Same-status no-op if
    // we're re-running on a run that already advanced.
    try {
      await transitionOnboarding(run.id, authReq.orgId, "signing");
    } catch {
      // Forbidden — likely the run is already past signing. Keep going,
      // the partial-success status is reported back to the caller.
    }

    const [refreshed] = await db
      .select()
      .from(agentOnboardingRunsTable)
      .where(
        and(
          eq(agentOnboardingRunsTable.id, run.id),
          eq(agentOnboardingRunsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    res.status(200).json({
      run: refreshed ?? run,
      paperworkGenerated: advanced.length,
      signTasks,
    });
  },
);

/**
 * POST /onboarding/:agentId/carriers/:carrierId/sign
 *
 * Day-5 native e-signature replacement (Beta). Previously synchronously
 * transitioned the carrier_contracting_request to `signed`; now it
 * creates an `esign_envelopes` row pointing at the paperwork PDF and
 * returns the signing URL. The actual state transition happens when the
 * envelope completes — see `lib/esign/mediflowProvider.ts` →
 * `recordSignature`, which calls `completeCarrierSigningTransition`
 * once the signed bytes are persisted.
 *
 * Permission: the agent themselves OR an admin / compliance manager.
 * `agent_support` is rejected because it doesn't own the handoff.
 *
 * Idempotent: re-posting while a non-voided envelope already exists for
 * the same carrier_contracting_request returns that envelope's metadata
 * (and its `signingUrl`) rather than creating a duplicate.
 */
router.post(
  "/onboarding/:agentId/carriers/:carrierId/sign",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);
    const carrierId = String(req.params.carrierId);

    const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const isAdmin =
      authReq.userRole === "super_admin" ||
      authReq.userRole === "agency_admin" ||
      authReq.userRole === "compliance_manager";
    const isOwningAgent =
      authReq.userRole === "agent" && agent.userId === authReq.userId;
    if (!isAdmin && !isOwningAgent) {
      res.status(403).json({
        error: "Only the agent themselves or an admin can start signing",
      });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    // Phase 1.5 deprecation: per-carrier signing is replaced by the
    // run-wide POA. If this run has been processed via the POA path
    // (pending / signed / opted_out), refuse new sign requests with 410.
    // In-flight legacy runs (poa_status = not_applicable) continue.
    if (run.poaStatus !== "not_applicable") {
      res.status(410).json({
        error:
          "Per-carrier signing has been deprecated. This onboarding run uses the POA flow — sign once via /sign/:envelopeId where envelopeId comes from POST /onboarding/:agentId/poa-decision.",
        poaStatus: run.poaStatus,
        nextRoute: `/onboarding/${agentId}/poa-decision`,
      });
      return;
    }

    const [request] = await db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
          eq(carrierContractingRequestsTable.onboardingRunId, run.id),
          eq(carrierContractingRequestsTable.carrierId, carrierId),
          sql`${carrierContractingRequestsTable.status} != 'cancelled'`,
        ),
      )
      .limit(1);
    if (!request) {
      res.status(404).json({
        error: "No contracting request for this agent + carrier pair",
      });
      return;
    }

    if (!request.paperworkDocumentId) {
      res.status(409).json({
        error:
          "Carrier paperwork not generated yet — call POST /onboarding/:agentId/request-contracting first",
      });
      return;
    }

    // Single-signer MVP: the signer is always the agent themselves. We
    // pull the display name from the agent row and the email from the
    // contracting profile (carrier paperwork uses that email).
    const [profile] = await db
      .select()
      .from(agentContractingProfilesTable)
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, agentId),
          eq(agentContractingProfilesTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    if (!agent.userId) {
      res.status(409).json({
        error:
          "Agent has no linked user account — cannot create signing envelope",
      });
      return;
    }
    const displayName =
      `${agent.firstName} ${agent.lastName}`.trim() || "agent";
    const [agentRow] = await db
      .select({ email: agentsTable.email })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    const signerEmail =
      profile?.email ?? agentRow?.email ?? "unknown@example.com";

    const envelope = await getEsignProvider().createEnvelope({
      orgId: authReq.orgId,
      carrierContractingRequestId: request.id,
      pdfDocumentId: request.paperworkDocumentId,
      signers: [
        {
          userId: agent.userId,
          displayName,
          email: signerEmail,
        },
      ],
      createdByUserId: authReq.userId,
      ipAddress: req.ip ?? null,
      userAgent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : null,
    });

    res.status(200).json({
      envelopeId: envelope.id,
      status: envelope.status,
      signingUrl: `/sign/${envelope.id}`,
      carrierContractingRequestId: request.id,
    });
  },
);

// ---- 501 stubs for Days 5+ -------------------------------------------------
//
// Listing these explicitly (vs. leaving them unimplemented) gives anyone
// picking up Days 3+ a clear "fill this in" target. Each route uses the
// real auth + permission middleware so callers see 403 (not 501) when
// unauthorized — which means the 501 is a true "endpoint exists, behavior
// not yet implemented" signal, not a routing miss.

// NOTE: the legacy `POST /onboarding/:agentId/carriers/:requestId/generate-paperwork`
// stub was superseded by `POST /onboarding/:agentId/request-contracting`
// (Day 3) — the new endpoint generates paperwork for ALL draft requests
// on the run in a single admin click, which matches the INSUREitALL
// workflow better than the per-request stub did.

router.post(
  "/onboarding/:agentId/signing/start",
  requireAuth,
  requirePermission("agent", "update"),
  async (_req: Request, res: Response): Promise<void> => {
    // TODO(day-5): start a Dropbox Sign envelope for the generated paperwork,
    // persist the envelope_id on every carrier_contracting_requests row, and
    // transition the onboarding run signing.
    res.status(501).json({
      error: "Not yet implemented — Day 5 (Dropbox Sign integration)",
    });
  },
);

router.post(
  "/onboarding/webhooks/esign",
  // NOTE: the real e-sig webhook will validate a provider signature header
  // and resolve auth from the envelope id, NOT from requireAuth. For now we
  // expose the path so the URL is stable.
  async (_req: Request, res: Response): Promise<void> => {
    // TODO(day-5): verify Dropbox Sign signature header, look up the
    // envelope on carrier_contracting_requests, transition signed →
    // submitted, dispatch to the carrier connector via submit().
    res.status(501).json({
      error: "Not yet implemented — Day 5 (Dropbox Sign webhook)",
    });
  },
);

router.post(
  "/onboarding/:agentId/submit",
  requireAuth,
  requirePermission("agent", "update"),
  async (_req: Request, res: Response): Promise<void> => {
    // TODO(day-6): for each signed carrier_contracting_request, build a
    // ContractingPacket (decrypting SSN/EIN), resolve the carrier connector
    // via resolveCarrierConnector, call .submit(), persist providerRequestId,
    // and transition the onboarding run to submitted.
    res.status(501).json({
      error: "Not yet implemented — Day 6 (carrier email-out)",
    });
  },
);

/**
 * PATCH /admin/contracting/:requestId
 *
 * Admin-facing writing-number / status entry. The carrier appointment desk
 * emails back a writing number + status decision (appointed / rejected /
 * under_review); a compliance manager records it here. When the LAST
 * outstanding request flips to `appointed`, `maybeAdvanceRunForRequests`
 * rolls the onboarding run forward to `complete`.
 *
 * Body (zod-validated): at least one of:
 *   - writingNumber  (string, ≤64 chars)
 *   - status         ("appointed" | "rejected" | "submitted" | "under_review")
 *   - notes          (string — overwrites; we replace rather than append so
 *                     the column stays a single concise carrier-desk note.
 *                     If a richer history is needed later, the audit_log
 *                     already records every transition.)
 *
 * Behaviour:
 *   - If `writingNumber` is set AND `status` is NOT explicitly provided,
 *     the request is transitioned to `appointed` (writing-number is the
 *     terminal data point of a successful appointment) and `appointed_at`
 *     is set to now().
 *   - If `status` is explicitly provided, transition via the contracting
 *     state machine. Forbidden transitions → 400.
 *   - Idempotent: a re-PATCH with the same body is a no-op (the state
 *     machine treats same-state as a no-op-allowed transition) and returns
 *     200 with the current row rather than 400.
 *
 * Permission: agency_admin / super_admin / compliance_manager.
 * Audit-log: a dedicated `auditMiddleware("carrier_contracting")` is
 *   wired on this route (the router-level middleware audits
 *   `agent_onboarding`).
 */
const AdminContractingPatchSchema = z
  .object({
    writingNumber: z.string().max(64).optional(),
    status: z
      .enum(["appointed", "rejected", "submitted", "under_review"])
      .optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine(
    (d) =>
      d.writingNumber !== undefined ||
      d.status !== undefined ||
      d.notes !== undefined,
    { message: "At least one of writingNumber, status, or notes is required" },
  );

router.patch(
  "/admin/contracting/:requestId",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  auditMiddleware("carrier_contracting", undefined, {
    getResourceId: (req) => {
      const raw = req.params.requestId;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const requestId = String(req.params.requestId);

    const parsed = AdminContractingPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const body = parsed.data;

    // Org-scoped lookup. A missing row OR a row in another org collapses
    // into the same 404 — neither leaks existence.
    const [current] = await db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.id, requestId),
          eq(carrierContractingRequestsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Contracting request not found" });
      return;
    }

    // Decide the target status:
    //   - explicit `status` → use it (validated against the state machine)
    //   - implicit (only writingNumber provided) → "appointed"
    //   - notes-only update → keep the current status
    const explicitStatus = body.status;
    const wantsAppointed =
      body.writingNumber !== undefined && explicitStatus === undefined;
    const targetStatus: ContractingStatus = explicitStatus
      ? explicitStatus
      : wantsAppointed
        ? "appointed"
        : (current.status as ContractingStatus);

    if (!isContractingStatus(targetStatus)) {
      res.status(400).json({ error: "Invalid target status" });
      return;
    }

    // Build the column patch. We replace `notes` rather than append — the
    // audit_log already preserves the (from, to) trail for every PATCH, so
    // a richer "comment thread" would be redundant here. Replace also
    // makes the route idempotent for the no-op case.
    const extra: Partial<typeof carrierContractingRequestsTable.$inferInsert> =
      {};
    if (body.writingNumber !== undefined) extra.writingNumber = body.writingNumber;
    if (body.notes !== undefined) extra.notes = body.notes;
    if (targetStatus === "appointed") extra.appointedAt = new Date();
    if (targetStatus === "submitted" && !current.submittedAt) {
      extra.submittedAt = new Date();
    }

    // Idempotency: same status + same writingNumber + same notes → no-op,
    // return current row with 200 (no audit-log transition is emitted
    // because nothing changed at the column level).
    const isNoop =
      targetStatus === current.status &&
      (body.writingNumber === undefined ||
        body.writingNumber === current.writingNumber) &&
      (body.notes === undefined || body.notes === current.notes);

    if (isNoop) {
      res.status(200).json({ request: current, idempotent: true });
      return;
    }

    let updated: CarrierContractingRequest | null;
    try {
      updated = await transitionContractingRequest(
        current.id,
        authReq.orgId,
        targetStatus,
        extra,
      );
    } catch (err) {
      if (err instanceof ForbiddenContractingTransitionError) {
        res.status(400).json({
          error: "Invalid state transition",
          from: err.from,
          to: err.to,
        });
        return;
      }
      throw err;
    }
    if (!updated) {
      res.status(404).json({ error: "Contracting request vanished" });
      return;
    }

    // Roll the run forward if the aggregate state warrants it. This is
    // where the LAST request → appointed flips the whole run → complete +
    // writes the notification row.
    await maybeAdvanceRunForRequests(updated.onboardingRunId, authReq.orgId);

    res.status(200).json({ request: updated, idempotent: false });
  },
);

// Re-export the SSN hash so tests can compute the same blind index value
// without re-importing from @workspace/db directly.
export const __testing = { hashSsn };
export default router;
