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
  encryptSsn,
  decryptSsn,
  encryptEin,
  decryptEin,
  hashSsn,
  type AgentContractingProfile,
  type AgentOnboardingRun,
  type CarrierContractingRequest,
} from "@workspace/db";
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
  isOnboardingStatus,
  ONBOARDING_STATUSES,
  ONBOARDING_STEP_ON_ENTER,
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

    if (!(await ensureAgentInOrg(agentId, authReq.orgId))) {
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

    try {
      await transitionOnboarding(
        run.id,
        authReq.orgId,
        "carriers_selected",
      );
    } catch {
      // Forbidden transition (e.g. caller selected carriers from a state
      // already past carriers_selected) — keep the inserts but skip the
      // status bump rather than rolling back.
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

// ---- 501 stubs for Days 3+ -------------------------------------------------
//
// Listing these explicitly (vs. leaving them unimplemented) gives anyone
// picking up Days 3+ a clear "fill this in" target. Each route uses the
// real auth + permission middleware so callers see 403 (not 501) when
// unauthorized — which means the 501 is a true "endpoint exists, behavior
// not yet implemented" signal, not a routing miss.

router.post(
  "/onboarding/:agentId/carriers/:requestId/generate-paperwork",
  requireAuth,
  requirePermission("agent", "update"),
  async (_req: Request, res: Response): Promise<void> => {
    // TODO(day-3/4): load profile + state-machine-validate (draft →
    // paperwork_generated), call pdfFiller.fillTemplate with the carrier's
    // template, store the PDF in objectStorage, link via documentsTable, and
    // update the carrier_contracting_requests row.
    res.status(501).json({
      error: "Not yet implemented — Day 3-4 (depends on INSUREitALL templates)",
    });
  },
);

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
