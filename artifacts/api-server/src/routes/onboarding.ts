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
import { and, eq, sql, type SQL } from "drizzle-orm";
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
  createCarrierSubmitTask,
  closeContractingTask,
  completeProfileTaskKey,
  adminReviewTaskKey,
  carrierSignTaskKey,
} from "../workers/contractingTasks";
import { buildDummyTemplate, fillTemplateFromBytes } from "../lib/contractingPdf/pdfFiller";
import {
  requireAuth,
  requirePermission,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";
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

// Roles that see SSN/EIN/DOB in plaintext. Same shape as PHI_PRIVILEGED_ROLES
// in routes/contacts.ts — the design partner expects identical handling for
// contracting PII as for contact PHI.
const PII_PRIVILEGED_ROLES = new Set([
  "super_admin",
  "agency_admin",
  "compliance_manager",
]);

const MASKED_SSN = "***-**-****";
const MASKED_EIN = "**-*******";

const router: IRouter = Router();

router.use(
  auditMiddleware("agent_onboarding", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.agentId;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
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
  const privileged = PII_PRIVILEGED_ROLES.has(userRole);

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
 * Day 3 behavior: the dummy template from `pdfFiller.buildDummyTemplate()`
 * is filled with the agent's name + a generated request id. Day 4 swaps
 * the real per-carrier INSUREitALL template in at the same call site;
 * the function shape is intentionally identical so that swap is one-file.
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
  // The dummy template ships two text fields and a checkbox. Day 4 will
  // replace this with the per-carrier field map; for Day 3 we just prove
  // the plumbing executes.
  await fillTemplateFromBytes(
    template,
    {
      fullName: agentName,
      ssn: "(see encrypted profile)",
      consent: true,
    },
    { flatten: true },
  );

  // Synthetic storage key — Day 3 doesn't yet wire object storage for
  // contracting PDFs (Day 4 task). The `documents` row exists so the
  // foreign key on `carrier_contracting_requests.paperwork_document_id`
  // is satisfied and admin UIs can show "paperwork generated".
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
        resourceId: run.id,
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

// ---- Day-3 routes ----------------------------------------------------------

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
 * Day 3 stand-in for the Dropbox-Sign webhook (Day 5). The agent (or an
 * admin on their behalf) confirms the contracting packet was signed —
 * we transition the request `paperwork_generated → signed` and create
 * the SYSTEM "Submit signed packet to {carrierName} appointment desk"
 * task (Day 6 worker drains those).
 *
 * Permission: the agent themselves OR an admin. We narrow the check by
 * loading the agent's linked user_id and comparing against the caller.
 * `agent_support` (whose `agent` permission is `read`-only) is rejected
 * because they don't own the workflow handoff.
 */
router.post(
  "/onboarding/:agentId/carriers/:carrierId/sign",
  requireAuth,
  // Permission check happens inline — the `agent:update` matrix doesn't
  // include the `agent` role, but an agent IS allowed to sign their own
  // paperwork. We narrow on (agent-self OR admin/compliance) below.
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = String(req.params.agentId);
    const carrierId = String(req.params.carrierId);

    const agent = await loadAgentForOrchestration(agentId, authReq.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Permission narrowing: only the agent themselves OR an admin role
    // can confirm a signature. agent_support reads everything but cannot
    // own this handoff.
    const isAdmin =
      authReq.userRole === "super_admin" ||
      authReq.userRole === "agency_admin" ||
      authReq.userRole === "compliance_manager";
    const isOwningAgent =
      authReq.userRole === "agent" && agent.userId === authReq.userId;
    if (!isAdmin && !isOwningAgent) {
      res.status(403).json({
        error: "Only the agent themselves or an admin can confirm signing",
      });
      return;
    }

    const run = await loadActiveOnboarding(agentId, authReq.orgId);
    if (!run) {
      res.status(404).json({ error: "No active onboarding run for agent" });
      return;
    }

    // Find the (singular) active carrier_contracting_request for this
    // (agent, carrier) pair. The partial-unique on the table guarantees
    // at most one non-cancelled row.
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

    // Idempotency: if already signed (or beyond), report the current
    // state and don't double-create the submit task.
    const alreadySigned = isContractingStatus(request.status)
      ? ["signed", "submitted", "under_review", "appointed", "rejected"].includes(
          request.status,
        )
      : false;

    const [carrier] = await db
      .select({ id: carriersTable.id, name: carriersTable.name })
      .from(carriersTable)
      .where(
        and(
          eq(carriersTable.id, carrierId),
          eq(carriersTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    const carrierName = carrier?.name ?? "the carrier";

    let signedRequest = request;
    if (!alreadySigned) {
      try {
        const updated = await transitionContractingRequest(
          request.id,
          authReq.orgId,
          "signed",
          { signatureCompletedAt: new Date() },
        );
        if (!updated) {
          res.status(404).json({ error: "Contracting request vanished" });
          return;
        }
        signedRequest = updated;
      } catch (err) {
        if (err instanceof ForbiddenContractingTransitionError) {
          res.status(409).json({
            error: "Cannot sign — invalid state transition",
            from: err.from,
            to: err.to,
          });
          return;
        }
        throw err;
      }
    }

    // Close the agent's sign task + create the SYSTEM submit task.
    await closeContractingTask(
      authReq.orgId,
      carrierSignTaskKey(run.id, request.id),
    );
    const submitTask = await createCarrierSubmitTask(signedRequest, carrierName);

    // Day-6 worker will flip the request to `submitted` and (eventually)
    // `appointed`. We still call maybeAdvanceRunForRequests here in case
    // a test or admin override has already pushed every request past
    // `signed`.
    await maybeAdvanceRunForRequests(run.id, authReq.orgId);

    res.status(200).json({
      request: signedRequest,
      submitTaskId: submitTask.id,
      idempotent: alreadySigned,
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

router.patch(
  "/onboarding/:agentId/carriers/:requestId/admin-status",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (_req: Request, res: Response): Promise<void> => {
    // TODO(day-6): admin status-override for a stuck carrier_contracting_request.
    // Validates the transition via canTransitionContracting and records the
    // override in the audit log.
    res.status(501).json({
      error: "Not yet implemented — Day 6 (admin status override)",
    });
  },
);

// Re-export the SSN hash so tests can compute the same blind index value
// without re-importing from @workspace/db directly.
export const __testing = { hashSsn };
export default router;
