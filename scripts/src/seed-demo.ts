/**
 * Demo seed script — populates a fresh dev DB with a believable Medicare
 * agency mid-onboarding, so the Friday INSUREitALL walkthrough has something
 * credible to demo.
 *
 * Idempotent: re-running is safe. By default the script skips entirely if
 * the demo org row already exists (fixed UUID makes this stable). Pass
 * `--reset` to wipe the demo org first and reseed.
 *
 * Run:
 *   pnpm seed:demo
 *   pnpm seed:demo -- --reset
 *
 * What gets created (under the org "INSUREitALL Demo"):
 *   - 4 users (super_admin, agency_admin, 2 agents)
 *   - 2 agent records (Carlos Reyes — CA/TX/FL/NY; Linda Park — FL)
 *   - 11 default-seeded carriers, all with `appointment_desk_email` set
 *   - Carlos onboarding run: status=complete, all carriers contracted
 *   - Linda onboarding run:  status=signing — 1 signed, 3 pending (LIVE)
 *   - ~30 realistic-but-fake Medicare lead contacts
 *   - A pipeline + a handful of deals + activities + tasks for the dashboard
 *   - 2 small commission statements for Carlos to exercise the commission UI
 *
 * Defense in depth:
 *   - SSNs are encrypted via the shared `encryptSsn` helper, so the
 *     encrypted columns are actually exercised. We deliberately use the
 *     999-XX-XXXX prefix (SSA-reserved test range) so anyone glancing at
 *     the DB sees obvious-fake data.
 *   - Uses the existing `seedDefaultCarriers` helper for the carrier list
 *     so we don't drift from production seed behavior.
 */
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import {
  db,
  organizationsTable,
  usersTable,
  agentsTable,
  stateLicensesTable,
  carriersTable,
  carrierCertificationsTable,
  contactsTable,
  pipelinesTable,
  pipelineStagesTable,
  dealsTable,
  activitiesTable,
  taskInstancesTable,
  agentOnboardingRunsTable,
  agentContractingProfilesTable,
  carrierContractingRequestsTable,
  commissionStatementsTable,
  commissionLineItemsTable,
  encryptSsn,
} from "@workspace/db";
import { seedDefaultCarriers } from "@workspace/api-server/lib/carrierSeed";

// ---- Stable fixed IDs ------------------------------------------------------
// Fixed UUIDs so re-runs land on the same rows and the demo URL stays stable.

const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001";
const USERS = {
  superAdmin: "00000000-0000-4000-8000-000000000010",
  agencyAdmin: "00000000-0000-4000-8000-000000000011",
  carlosUser: "00000000-0000-4000-8000-000000000012",
  lindaUser: "00000000-0000-4000-8000-000000000013",
};
const AGENTS = {
  carlos: "00000000-0000-4000-8000-000000000020",
  linda: "00000000-0000-4000-8000-000000000021",
};
const PIPELINE_ID = "00000000-0000-4000-8000-000000000030";
const STAGES = {
  newLead: "00000000-0000-4000-8000-000000000031",
  contacted: "00000000-0000-4000-8000-000000000032",
  appointment: "00000000-0000-4000-8000-000000000033",
  enrolled: "00000000-0000-4000-8000-000000000034",
};

// ---- Tiny CLI parsing ------------------------------------------------------

const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const QUIET = args.has("--quiet");

function log(...parts: unknown[]): void {
  if (!QUIET) console.log(...parts);
}

// ---- Deterministic ID helper -----------------------------------------------
// Build child IDs from a stable prefix so reseeds with the same input land
// on the same UUID-shaped strings (idempotency without table-by-table
// "upsert" plumbing). We're not picky about UUID validity here — the columns
// are plain `text`, and the prefix makes ownership obvious in a DB browser.

function stableId(scope: string, key: string): string {
  const h = createHash("sha1").update(`${DEMO_ORG_ID}:${scope}:${key}`).digest("hex");
  return `demo-${scope}-${h.slice(0, 16)}`;
}

// ---- Reset -----------------------------------------------------------------

async function resetDemoOrg(): Promise<void> {
  log("[reset] wiping demo org rows…");
  // Order matters — child tables before parents to satisfy FKs that don't
  // cascade. Cascade is wired on most agent-keyed children, but we delete
  // explicitly so a partially-cascading schema change can't leave orphans.
  await db
    .delete(commissionLineItemsTable)
    .where(eq(commissionLineItemsTable.orgId, DEMO_ORG_ID));
  await db
    .delete(commissionStatementsTable)
    .where(eq(commissionStatementsTable.orgId, DEMO_ORG_ID));
  await db
    .delete(carrierContractingRequestsTable)
    .where(eq(carrierContractingRequestsTable.orgId, DEMO_ORG_ID));
  await db
    .delete(agentContractingProfilesTable)
    .where(eq(agentContractingProfilesTable.orgId, DEMO_ORG_ID));
  await db
    .delete(agentOnboardingRunsTable)
    .where(eq(agentOnboardingRunsTable.orgId, DEMO_ORG_ID));
  await db
    .delete(taskInstancesTable)
    .where(eq(taskInstancesTable.orgId, DEMO_ORG_ID));
  await db
    .delete(activitiesTable)
    .where(eq(activitiesTable.orgId, DEMO_ORG_ID));
  await db.delete(dealsTable).where(eq(dealsTable.orgId, DEMO_ORG_ID));
  // pipeline stages cascade from pipelines; clear pipelines after deals
  await db
    .delete(pipelinesTable)
    .where(eq(pipelinesTable.orgId, DEMO_ORG_ID));
  await db
    .delete(contactsTable)
    .where(eq(contactsTable.orgId, DEMO_ORG_ID));
  await db
    .delete(carrierCertificationsTable)
    .where(
      // certifications cascade from agents, but be explicit for stragglers
      // that were created from another org's agentId (shouldn't happen here,
      // but the foot-gun is cheap to defuse).
      eq(carrierCertificationsTable.id, ""), // no-op guard; cascade handles it
    );
  await db
    .delete(stateLicensesTable)
    .where(eq(stateLicensesTable.id, "")); // cascade from agents
  await db.delete(agentsTable).where(eq(agentsTable.orgId, DEMO_ORG_ID));
  await db.delete(carriersTable).where(eq(carriersTable.orgId, DEMO_ORG_ID));
  await db.delete(usersTable).where(eq(usersTable.orgId, DEMO_ORG_ID));
  await db
    .delete(organizationsTable)
    .where(eq(organizationsTable.id, DEMO_ORG_ID));
  log("[reset] done");
}

// ---- Core seeders ----------------------------------------------------------

/** Seed the demo org. Returns false when ANOTHER concurrent seeder won the
 *  org insert — the org row is the serialization point for the whole seed:
 *  the loser defers entirely instead of racing every downstream seeder's
 *  check-then-insert (users_pkey, agents_pkey, ...). */
async function seedOrg(): Promise<boolean> {
  const existing = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, DEMO_ORG_ID));
  if (existing.length > 0) {
    log("[org] INSUREitALL Demo already exists");
    return true;
  }
  const res = await db
    .insert(organizationsTable)
    .values({
      id: DEMO_ORG_ID,
      name: "INSUREitALL Demo",
      slug: "insureitall-demo",
      planTier: "growth",
    })
    .onConflictDoNothing({ target: organizationsTable.id });
  if ((res as unknown as { rowCount?: number | null }).rowCount === 0) {
    log("[org] another seeder is creating the demo data concurrently — deferring to it");
    return false;
  }
  log("[org] created INSUREitALL Demo");
  return true;
}

interface UserSeed {
  id: string;
  email: string;
  fullName: string;
  role: "super_admin" | "agency_admin" | "agent";
}

const USER_ROWS: UserSeed[] = [
  {
    id: USERS.superAdmin,
    email: "sarah@insureitall.example",
    fullName: "Sarah Stevens",
    role: "super_admin",
  },
  {
    id: USERS.agencyAdmin,
    email: "marcus@insureitall.example",
    fullName: "Marcus Lee",
    role: "agency_admin",
  },
  {
    id: USERS.carlosUser,
    email: "carlos@insureitall.example",
    fullName: "Carlos Reyes",
    role: "agent",
  },
  {
    id: USERS.lindaUser,
    email: "linda@insureitall.example",
    fullName: "Linda Park",
    role: "agent",
  },
];

async function seedUsers(): Promise<void> {
  for (const u of USER_ROWS) {
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, u.id));
    if (existing.length === 0) {
      await db.insert(usersTable).values({
        id: u.id,
        orgId: DEMO_ORG_ID,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        isActive: true,
      }).onConflictDoNothing();
    }
  }
  log(`[users] ensured ${USER_ROWS.length} users`);
}

async function seedAgents(): Promise<{
  carlos: { id: string };
  linda: { id: string };
}> {
  // Carlos — multi-state veteran (the "everything's done" example)
  const carlos = {
    id: AGENTS.carlos,
    orgId: DEMO_ORG_ID,
    userId: USERS.carlosUser,
    npn: "20451817",
    firstName: "Carlos",
    lastName: "Reyes",
    email: "carlos@insureitall.example",
    phone: "+13105550101",
    status: "active" as const,
    hireDate: new Date("2023-02-14T00:00:00Z"),
  };
  // Linda — single-state newcomer (the live demo example)
  const linda = {
    id: AGENTS.linda,
    orgId: DEMO_ORG_ID,
    userId: USERS.lindaUser,
    npn: "21339042",
    firstName: "Linda",
    lastName: "Park",
    email: "linda@insureitall.example",
    phone: "+19045550144",
    status: "onboarding" as const,
    hireDate: new Date("2025-04-30T00:00:00Z"),
  };

  for (const a of [carlos, linda]) {
    const existing = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.id, a.id));
    if (existing.length === 0) {
      await db.insert(agentsTable).values(a).onConflictDoNothing();
    }
  }

  // Licenses
  const licenses: Array<{ agentId: string; state: string }> = [
    { agentId: carlos.id, state: "CA" },
    { agentId: carlos.id, state: "TX" },
    { agentId: carlos.id, state: "FL" },
    { agentId: carlos.id, state: "NY" },
    { agentId: linda.id, state: "FL" },
  ];
  for (const l of licenses) {
    const id = stableId("license", `${l.agentId}-${l.state}`);
    const existing = await db
      .select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .where(eq(stateLicensesTable.id, id));
    if (existing.length === 0) {
      await db.insert(stateLicensesTable).values({
        id,
        agentId: l.agentId,
        stateCode: l.state,
        licenseType: "Resident Producer — Accident & Health",
        licenseNumber: `${l.state}-${Math.floor(100000 + Math.random() * 900000)}`,
        issueDate: new Date("2023-01-15T00:00:00Z"),
        expiryDate: new Date("2026-01-15T00:00:00Z"),
        status: "active",
      }).onConflictDoNothing();
    }
  }
  log(`[agents] ensured Carlos + Linda with ${licenses.length} licenses`);

  return { carlos: { id: carlos.id }, linda: { id: linda.id } };
}

async function seedCarriersWithDeskEmails(): Promise<
  Array<{ id: string; name: string }>
> {
  // Reuse the production helper so we never drift on the canonical list.
  await seedDefaultCarriers(DEMO_ORG_ID);
  const carriers = await db
    .select({
      id: carriersTable.id,
      name: carriersTable.name,
      appointmentDeskEmail: carriersTable.appointmentDeskEmail,
    })
    .from(carriersTable)
    .where(eq(carriersTable.orgId, DEMO_ORG_ID))
    .orderBy(carriersTable.name);

  // Populate appointment_desk_email + a metadata stub on each carrier where
  // it's missing. The sandbox `.example` TLD is reserved for documentation
  // and is never deliverable, so it's safe to ship in a demo environment.
  for (const c of carriers) {
    if (c.appointmentDeskEmail) continue;
    const slug = c.name
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "");
    await db
      .update(carriersTable)
      .set({
        appointmentDeskEmail: `appointments@${slug}.example`,
        appointmentDeskMetadata: {
          cc: ["compliance@insureitall.example"],
          subject: `New agent appointment packet — ${c.name}`,
        },
      })
      .where(eq(carriersTable.id, c.id));
  }
  log(`[carriers] ensured ${carriers.length} carriers with desk emails`);
  return carriers.map((c) => ({ id: c.id, name: c.name }));
}

interface ProfileSeed {
  agentId: string;
  ssn: string;
  dob: string;
  addr1: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
}

async function seedContractingProfile(p: ProfileSeed): Promise<void> {
  const existing = await db
    .select({ agentId: agentContractingProfilesTable.agentId })
    .from(agentContractingProfilesTable)
    .where(eq(agentContractingProfilesTable.agentId, p.agentId));
  const { encrypted, hash } = encryptSsn(p.ssn);
  if (existing.length === 0) {
    await db.insert(agentContractingProfilesTable).values({
      agentId: p.agentId,
      orgId: DEMO_ORG_ID,
      ssnEncrypted: encrypted,
      ssnHash: hash,
      dob: p.dob,
      homeAddressLine1: p.addr1,
      homeCity: p.city,
      homeState: p.state,
      homeZip: p.zip,
      mailingSameAsHome: true,
      phone: p.phone,
      email: p.email,
      entityType: "individual",
      backgroundCheckStatus: "cleared",
      backgroundCheckClearedAt: new Date("2025-04-01T00:00:00Z"),
    }).onConflictDoNothing();
  } else {
    await db
      .update(agentContractingProfilesTable)
      .set({
        ssnEncrypted: encrypted,
        ssnHash: hash,
      })
      .where(eq(agentContractingProfilesTable.agentId, p.agentId));
  }
}

async function seedOnboardingForCarlos(
  carrierIds: Array<{ id: string; name: string }>,
): Promise<void> {
  // SSA-reserved test range; clearly fake. The encryption helper enforces
  // a 9-digit SSN so we just feed digits.
  await seedContractingProfile({
    agentId: AGENTS.carlos,
    ssn: "999-12-3456",
    dob: "1978-07-21",
    addr1: "120 Sunset Blvd",
    city: "Los Angeles",
    state: "CA",
    zip: "90028",
    phone: "+13105550101",
    email: "carlos@insureitall.example",
  });

  const runId = stableId("onboarding-run", "carlos");
  const existing = await db
    .select({ id: agentOnboardingRunsTable.id })
    .from(agentOnboardingRunsTable)
    .where(eq(agentOnboardingRunsTable.id, runId));
  if (existing.length === 0) {
    await db.insert(agentOnboardingRunsTable).values({
      id: runId,
      orgId: DEMO_ORG_ID,
      agentId: AGENTS.carlos,
      startedByUserId: USERS.agencyAdmin,
      status: "complete",
      startedAt: new Date("2023-02-14T00:00:00Z"),
      completedAt: new Date("2023-03-10T00:00:00Z"),
      completedSteps: { profile: true, carriers: true, signing: true },
    }).onConflictDoNothing();
  }

  // Carlos is appointed at every carrier with a writing number.
  for (const c of carrierIds) {
    const reqId = stableId("ccr-carlos", c.id);
    const exists = await db
      .select({ id: carrierContractingRequestsTable.id })
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, reqId));
    if (exists.length === 0) {
      // Hash the carrier name to a stable 6-digit writing number.
      const wn = createHash("sha1")
        .update(`carlos:${c.name}`)
        .digest("hex")
        .replace(/\D/g, "")
        .slice(0, 6)
        .padStart(6, "0");
      await db.insert(carrierContractingRequestsTable).values({
        id: reqId,
        orgId: DEMO_ORG_ID,
        onboardingRunId: runId,
        agentId: AGENTS.carlos,
        carrierId: c.id,
        states: ["CA", "TX", "FL", "NY"],
        status: "appointed",
        submittedAt: new Date("2023-02-25T00:00:00Z"),
        appointedAt: new Date("2023-03-08T00:00:00Z"),
        writingNumber: `WN-${wn}`,
      }).onConflictDoNothing();
    }
  }
  log("[onboarding] Carlos: complete, all carriers appointed");
}

async function seedOnboardingForLinda(
  carriers: Array<{ id: string; name: string }>,
): Promise<void> {
  await seedContractingProfile({
    agentId: AGENTS.linda,
    ssn: "999-77-8899",
    dob: "1985-11-04",
    addr1: "440 Riverside Ave",
    city: "Jacksonville",
    state: "FL",
    zip: "32202",
    phone: "+19045550144",
    email: "linda@insureitall.example",
  });

  const runId = stableId("onboarding-run", "linda");
  const existing = await db
    .select({ id: agentOnboardingRunsTable.id })
    .from(agentOnboardingRunsTable)
    .where(eq(agentOnboardingRunsTable.id, runId));
  if (existing.length === 0) {
    await db.insert(agentOnboardingRunsTable).values({
      id: runId,
      orgId: DEMO_ORG_ID,
      agentId: AGENTS.linda,
      startedByUserId: USERS.agencyAdmin,
      status: "signing",
      startedAt: new Date("2025-05-15T00:00:00Z"),
      completedSteps: { profile: true, carriers: true },
    }).onConflictDoNothing();
  }

  // Pick 4 carriers — Aetna/CVS, Humana, UnitedHealth/AARP, Devoted —
  // matching the brief. Look them up by name from the seeded list so the
  // demo doesn't depend on insertion order.
  const wanted = ["Aetna/CVS", "Humana", "UnitedHealth/AARP", "Devoted"];
  const selected = wanted
    .map((name) => carriers.find((c) => c.name === name))
    .filter((c): c is { id: string; name: string } => Boolean(c));

  // First selected carrier = signed; rest = paperwork_generated (live demo
  // walks the admin through signing those).
  selected.forEach(() => {
    /* iterate below with index */
  });
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]!;
    const reqId = stableId("ccr-linda", c.id);
    const exists = await db
      .select({ id: carrierContractingRequestsTable.id })
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, reqId));
    if (exists.length === 0) {
      const status = i === 0 ? "signed" : "paperwork_generated";
      await db.insert(carrierContractingRequestsTable).values({
        id: reqId,
        orgId: DEMO_ORG_ID,
        onboardingRunId: runId,
        agentId: AGENTS.linda,
        carrierId: c.id,
        states: ["FL"],
        status,
        signatureCompletedAt:
          status === "signed" ? new Date("2025-05-22T15:32:00Z") : null,
      }).onConflictDoNothing();
    }
  }
  log(
    `[onboarding] Linda: signing — 1 signed, ${selected.length - 1} pending`,
  );
}

// ---- Contacts (≈30 realistic-but-fake Medicare leads) ----------------------

const FIRST_NAMES = [
  "Margaret", "Robert", "Patricia", "James", "Linda", "Michael",
  "Barbara", "William", "Elizabeth", "David", "Susan", "Richard",
  "Jessica", "Joseph", "Karen", "Thomas", "Nancy", "Charles",
  "Lisa", "Daniel", "Betty", "Matthew", "Helen", "Anthony",
  "Sandra", "Mark", "Donna", "Steven", "Carol", "Paul",
];
const LAST_NAMES = [
  "Anderson", "Brown", "Chen", "Davis", "Edwards", "Foster",
  "Garcia", "Hernandez", "Iverson", "Johnson", "Kelly", "Lopez",
  "Miller", "Nguyen", "OBrien", "Patel", "Quinn", "Roberts",
  "Singh", "Taylor", "Underwood", "Valdez", "Williams", "Xu",
  "Young", "Zimmerman", "Adams", "Baker", "Cooper", "Diaz",
];
const STATES_FL_CA_TX_NY = ["FL", "CA", "TX", "NY"];
const PLAN_TYPES = ["MA", "MAPD", "PDP", "supp"] as const;
const STATUSES = ["lead", "prospect", "enrolled", "retained"] as const;

async function seedContacts(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const last = LAST_NAMES[(i * 7) % LAST_NAMES.length]!;
    const id = stableId("contact", `${first}-${last}-${i}`);
    ids.push(id);
    const exists = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(eq(contactsTable.id, id));
    if (exists.length > 0) continue;
    const state = STATES_FL_CA_TX_NY[i % 4]!;
    const planType = PLAN_TYPES[i % PLAN_TYPES.length]!;
    const status = STATUSES[i % STATUSES.length]!;
    const phoneTail = String(5550000 + i).padStart(7, "0");
    await db.insert(contactsTable).values({
      id,
      orgId: DEMO_ORG_ID,
      assignedAgentId: i % 3 === 0 ? AGENTS.linda : AGENTS.carlos,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: `+1${phoneTail.slice(0, 3)}${phoneTail}`.slice(0, 12),
      stateCode: state,
      zipCode: state === "CA" ? "90210" : state === "TX" ? "75001" : state === "NY" ? "10001" : "33101",
      currentPlanType: planType,
      planYear: 2025,
      status,
      leadSource: i % 2 === 0 ? "Inbound web" : "Referral",
    }).onConflictDoNothing();
  }
  log(`[contacts] ensured ${ids.length} contacts`);
  return ids;
}

// ---- Pipeline + deals + activities + tasks ---------------------------------

async function seedPipelineAndDeals(contactIds: string[]): Promise<void> {
  // No pipeline-exists gate here: both inserts use fixed ids +
  // onConflictDoNothing, so re-running them is already a no-op. Gating the
  // stages on the PIPELINE row made a crash between the two inserts
  // unrecoverable — the resume run would skip the stages forever and every
  // deal insert would then fail its stage_id FK.
  await db.insert(pipelinesTable).values({
    id: PIPELINE_ID,
    orgId: DEMO_ORG_ID,
    name: "Medicare AEP 2025",
    description: "Annual Enrollment Period pipeline",
    isDefault: true,
  }).onConflictDoNothing();
  await db.insert(pipelineStagesTable).values([
    {
      id: STAGES.newLead,
      pipelineId: PIPELINE_ID,
      name: "New Lead",
      orderIndex: 0,
      color: "#94a3b8",
      probabilityPct: 10,
    },
    {
      id: STAGES.contacted,
      pipelineId: PIPELINE_ID,
      name: "Contacted",
      orderIndex: 1,
      color: "#3b82f6",
      probabilityPct: 30,
    },
    {
      id: STAGES.appointment,
      pipelineId: PIPELINE_ID,
      name: "Appointment Set",
      orderIndex: 2,
      color: "#a855f7",
      probabilityPct: 60,
    },
    {
      id: STAGES.enrolled,
      pipelineId: PIPELINE_ID,
      name: "Enrolled",
      orderIndex: 3,
      color: "#22c55e",
      probabilityPct: 100,
    },
  ]).onConflictDoNothing();

  const dealStageRotation = [
    STAGES.newLead,
    STAGES.contacted,
    STAGES.appointment,
    STAGES.enrolled,
  ];
  // 8 deals across the first 8 contacts to give the dashboard a pulse.
  for (let i = 0; i < 8; i++) {
    const contactId = contactIds[i];
    if (!contactId) break;
    const dealId = stableId("deal", contactId);
    const exists = await db
      .select({ id: dealsTable.id })
      .from(dealsTable)
      .where(eq(dealsTable.id, dealId));
    if (exists.length === 0) {
      await db.insert(dealsTable).values({
        id: dealId,
        orgId: DEMO_ORG_ID,
        pipelineId: PIPELINE_ID,
        stageId: dealStageRotation[i % 4]!,
        contactId,
        assignedAgentId: i % 2 === 0 ? AGENTS.carlos : AGENTS.linda,
        title: `MAPD enrollment — ${(i + 1) * 100}/mo`,
        valueEst: 1200 + i * 75,
        status: i % 4 === 3 ? "won" : "open",
        wonAt: i % 4 === 3 ? new Date("2025-05-10T00:00:00Z") : null,
      }).onConflictDoNothing();
    }
  }

  // A handful of activities for the dashboard feed.
  for (let i = 0; i < 6; i++) {
    const contactId = contactIds[i];
    if (!contactId) break;
    const id = stableId("activity", `${contactId}-${i}`);
    const exists = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(eq(activitiesTable.id, id));
    if (exists.length === 0) {
      await db.insert(activitiesTable).values({
        id,
        orgId: DEMO_ORG_ID,
        contactId,
        agentId: i % 2 === 0 ? AGENTS.carlos : AGENTS.linda,
        type: i % 3 === 0 ? "call_log" : i % 3 === 1 ? "note" : "email",
        body:
          i % 3 === 0
            ? "Talked through plan options. Sending Aetna SOB."
            : i % 3 === 1
              ? "Lead wants to compare Humana vs UHC for Q4."
              : "Sent follow-up summary email.",
        createdBy: USERS.carlosUser,
      }).onConflictDoNothing();
    }
  }

  // A few open tasks.
  const tasks = [
    {
      title: "Follow up with Margaret Anderson",
      assignedToUserId: USERS.carlosUser,
      priority: "medium" as const,
    },
    {
      title: "Submit Humana writing-number request",
      assignedToUserId: USERS.agencyAdmin,
      priority: "high" as const,
    },
    {
      title: "Review Linda's contracting packet",
      assignedToUserId: USERS.agencyAdmin,
      priority: "high" as const,
    },
  ];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const id = stableId("task", `${t.title}-${i}`);
    const exists = await db
      .select({ id: taskInstancesTable.id })
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.id, id));
    if (exists.length === 0) {
      await db.insert(taskInstancesTable).values({
        id,
        orgId: DEMO_ORG_ID,
        title: t.title,
        assignedToUserId: t.assignedToUserId,
        status: "open",
        priority: t.priority,
        dueDate: new Date(Date.now() + (i + 1) * 86400000),
      }).onConflictDoNothing();
    }
  }
  log("[crm] ensured pipeline + 8 deals + 6 activities + 3 tasks");
}

// ---- Commission statements -------------------------------------------------

// Shared between seedCommissions and seedAll's completion marker so neither
// can drift silently: the marker IS the last line item of the last statement,
// derived from these constants rather than a duplicated literal ~700 lines
// away. Reordering the slugs or changing the per-statement line count updates
// both sides at once.
const COMMISSION_STATEMENT_SLUGS = ["aetna-2025-04", "humana-2025-04"] as const;
const COMMISSION_LINES_PER_STATEMENT = 4;
const LAST_COMMISSION_LINE_ID = stableId(
  "line",
  `${stableId("stmt", COMMISSION_STATEMENT_SLUGS[COMMISSION_STATEMENT_SLUGS.length - 1]!)}-${COMMISSION_LINES_PER_STATEMENT - 1}`,
);

async function seedCommissions(
  carriers: Array<{ id: string; name: string }>,
  contactIds: string[],
): Promise<void> {
  // Pick Aetna + Humana for the two sample statements.
  const aetna = carriers.find((c) => c.name === "Aetna/CVS");
  const humana = carriers.find((c) => c.name === "Humana");
  if (!aetna || !humana) {
    log("[commissions] skipping — Aetna/Humana not found");
    return;
  }

  const statements = [
    {
      id: stableId("stmt", COMMISSION_STATEMENT_SLUGS[0]),
      carrierId: aetna.id,
      statementDate: "2025-04-15",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      totalAmount: "2450.00",
    },
    {
      id: stableId("stmt", COMMISSION_STATEMENT_SLUGS[1]),
      carrierId: humana.id,
      statementDate: "2025-04-15",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      totalAmount: "1875.50",
    },
  ];

  for (const s of statements) {
    // Guard on line-item COMPLETENESS, not statement existence: a crash
    // between the statement insert and its line items would otherwise leave
    // a permanently empty statement — the statement-exists check skipped the
    // whole block on resume. All inserts below are id-stable +
    // onConflictDoNothing, so re-running the incomplete branch is safe.
    const existingLines = await db
      .select({ id: commissionLineItemsTable.id })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, s.id));
    if (existingLines.length < COMMISSION_LINES_PER_STATEMENT) {
      await db.insert(commissionStatementsTable).values({
        id: s.id,
        orgId: DEMO_ORG_ID,
        carrierId: s.carrierId,
        statementDate: s.statementDate,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        totalAmount: s.totalAmount,
        currency: "USD",
        source: "manual",
        status: "reconciled",
        uploadedByUserId: USERS.agencyAdmin,
      }).onConflictDoNothing();

      // 4 line items per statement, all crediting Carlos.
      for (let i = 0; i < COMMISSION_LINES_PER_STATEMENT; i++) {
        const contactId = contactIds[i % contactIds.length] ?? null;
        const lineId = stableId("line", `${s.id}-${i}`);
        await db.insert(commissionLineItemsTable).values({
          id: lineId,
          statementId: s.id,
          orgId: DEMO_ORG_ID,
          contactId,
          memberId: `MBR-${(1000 + i).toString()}`,
          policyNumber: `POL-${s.carrierId.slice(0, 6)}-${i}`,
          planType: "MAPD",
          planYear: 2025,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          premium: "175.00",
          commissionAmount: i === 0 ? "612.50" : i === 1 ? "612.50" : "612.50",
          type: i === 0 ? "initial" : "renewal",
          writingAgentId: AGENTS.carlos,
          matchStatus: "matched",
        }).onConflictDoNothing();
      }
    }
  }
  log(`[commissions] ensured ${statements.length} statements (4 lines each)`);
}

// ---- Main ------------------------------------------------------------------

// Whole-run serialization: the org-insert defer only guards the FIRST seed;
// the resume branch (org exists, seed incomplete) previously let two boots
// race check-then-insert seeders. One try-lock covers every branch. Same key
// discipline as migrate-locked.ts. (seedDefaultCarriers now ALSO self-
// serializes with a per-org pg_advisory_xact_lock — that closes the prod
// org-creation double-submit path this run-level lock can't see.)
const SEED_LOCK_KEY = 981_234_502;

/**
 * Refuse to plant demo data into anything that looks like a real database.
 *
 * This script writes a hardcoded `super_admin` identity
 * (sarah@insureitall.example), a fixed org, users, agents, carriers, and
 * contacts carrying fake `999-XX-XXXX` SSNs. None of that belongs in a
 * database holding real PHI, and `seedAll()` is NOT transactional — a run
 * that dies partway (e.g. at `encryptSsn`) leaves the org, users, agents and
 * carriers committed, and the resume branch then completes the plant on the
 * next attempt rather than raising a fresh alarm.
 *
 * `predeploy-seed.ts` gates the Railway deploy path on DEMO_MODE, but this
 * guard is the one that protects a human running `pnpm seed:demo` by hand
 * against whatever DATABASE_URL happens to be exported. It lives here so the
 * protection travels with the dangerous code rather than with one caller.
 *
 * Two shapes are refused, both overridable only by an explicit DEMO_MODE=true:
 *   - NODE_ENV=production.
 *   - An explicitly-set PHI_ENCRYPTION_KEY. `lib/prodEnvGuard.ts` already
 *     treats an explicit PHI key as production-looking (test/dev fall back to
 *     a dev sentinel), and reusing that heuristic covers the case where
 *     NODE_ENV is simply unset — where the seed would otherwise complete
 *     silently under the dev-sentinel keys.
 */
/**
 * Report DATABASE_URL as production-looking when it points anywhere but
 * loopback, mirroring `detectProdLikeCredentials()` in
 * `artifacts/api-server/src/lib/prodEnvGuard.ts`.
 *
 * This is the shape that slips past the other two checks: exporting only a
 * production DATABASE_URL to run a one-off script, with NODE_ENV and
 * PHI_ENCRYPTION_KEY both unset. `isNonProdEnv()` treats an undefined
 * NODE_ENV as non-production, so `encryptSsn` quietly falls back to the dev
 * sentinel keys and the whole seed completes against the remote database.
 *
 * Requiring DEMO_MODE=true for a remote host matches prodEnvGuard, which
 * tolerates a remote DATABASE_URL specifically and only under demo mode
 * ("a remote demo DATABASE_URL is expected and allowed").
 *
 * An unparseable URL yields null rather than throwing: `main()` reports a
 * bad DATABASE_URL better than this guard can, and a parse failure is not
 * evidence of production.
 */
function remoteDatabaseHost(): string | null {
  const raw = process.env["DATABASE_URL"];
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return null;
  }
  return `DATABASE_URL host "${host}" is not localhost/127.0.0.1`;
}

function assertSafeToSeed(): void {
  if (process.env["DEMO_MODE"] === "true") return;

  const reasons = [
    process.env["NODE_ENV"] === "production" ? "NODE_ENV=production" : null,
    process.env["PHI_ENCRYPTION_KEY"] ? "PHI_ENCRYPTION_KEY is set" : null,
    remoteDatabaseHost(),
  ].filter(Boolean);

  if (reasons.length === 0) return;

  throw new Error(
    `[seed] refusing to seed demo data (${reasons.join("; ")}) without DEMO_MODE=true. ` +
      "This script plants a hardcoded super_admin identity and fake-SSN contacts " +
      "and must never run against a real PHI database. If this really is a demo " +
      "deployment, set DEMO_MODE=true.",
  );
}

async function main(): Promise<void> {
  assertSafeToSeed();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await lockClient.connect();
  const lockRes = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
    SEED_LOCK_KEY,
  ]);
  if (!lockRes.rows[0]?.locked) {
    // WAIT for the winner instead of exiting immediately: startCommand
    // chains `seed:demo; start`, so an early rc=0 here would boot the
    // api-server while the peer is still writing demo rows — users would
    // briefly see empty lists. Acquiring the lock (bounded, 120s) proves
    // the peer finished; on timeout we boot anyway (seed is fail-open by
    // design and the data self-heals on the next wake).
    log("[seed] another seeder holds the lock — waiting for it to finish");
    const deadline = Date.now() + 120_000;
    let acquired = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const again = await lockClient.query(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [SEED_LOCK_KEY],
      );
      if (again.rows[0]?.locked) {
        acquired = true;
        break;
      }
    }
    if (acquired) {
      // Acquiring the lock proves the peer's SESSION ended — not that it
      // finished: a crashed peer releases the advisory lock too. Verify the
      // completion marker before claiming success; if it's missing, WE now
      // hold the lock, so resume the (idempotent) seed ourselves instead of
      // logging a false green.
      const done = await db
        .select({ id: commissionLineItemsTable.id })
        .from(commissionLineItemsTable)
        .where(eq(commissionLineItemsTable.id, LAST_COMMISSION_LINE_ID))
        .limit(1);
      try {
        if (done.length === 0) {
          log("[seed] peer released the lock but the completion marker is missing (crashed mid-seed?) — resuming");
          await seedAll();
        } else {
          log("[seed] peer seeder finished — demo data present; exiting cleanly");
        }
      } finally {
        await lockClient
          .query("SELECT pg_advisory_unlock($1)", [SEED_LOCK_KEY])
          .catch(() => {
            /* session teardown releases the lock anyway */
          });
      }
    } else {
      // Fail-open, but with an HONEST log: we cannot seed here (a live peer
      // still holds the lock — racing it is what the lock prevents), but we
      // CAN report whether the data it's writing is complete yet, so the
      // boot log doesn't imply a ready demo that isn't.
      const done = await db
        .select({ id: commissionLineItemsTable.id })
        .from(commissionLineItemsTable)
        .where(eq(commissionLineItemsTable.id, LAST_COMMISSION_LINE_ID))
        .limit(1);
      log(
        done.length > 0
          ? "[seed] peer still holds the lock after 120s but data is complete — booting"
          : "[seed] peer still holds the lock after 120s and seed is INCOMPLETE — booting anyway (fail-open); demo may look empty until the peer finishes or the next wake",
      );
    }
    await lockClient.end();
    return;
  }
  try {
    await seedAll();
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [SEED_LOCK_KEY])
      .catch(() => {
        /* session teardown releases the lock anyway */
      });
    await lockClient.end();
  }
}

async function seedAll(): Promise<void> {
  const existing = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, DEMO_ORG_ID));

  // Completion marker, NOT the org row: a seed that crashed mid-run leaves
  // the org behind, and skipping on org-exists would freeze that partial
  // state forever. The marker is the LAST row the LAST seeder writes — the
  // 4th line item of the humana statement — so a crash at ANY earlier point
  // (including between a statement and its line items) leaves it missing and
  // the next boot resumes the idempotent seeders. Checking statement
  // existence froze a statement-without-line-items crash forever.
  if (existing.length > 0 && !RESET) {
    const done = await db
      .select({ id: commissionLineItemsTable.id })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, LAST_COMMISSION_LINE_ID))
      .limit(1);
    if (done.length > 0) {
      log(
        "[seed] demo org fully seeded — skipping. Pass --reset to wipe + reseed.",
      );
      return;
    }
    log("[seed] demo org exists but seed looks incomplete — resuming");
  }

  if (RESET && existing.length > 0) {
    await resetDemoOrg();
  }

  log("[seed] seeding INSUREitALL Demo…");
  const wonOrCurrent = await seedOrg();
  if (!wonOrCurrent) {
    log("[seed] concurrent seeder active — exiting cleanly; it will finish the job");
    return;
  }
  await seedUsers();
  await seedAgents();
  const carriers = await seedCarriersWithDeskEmails();
  await seedOnboardingForCarlos(carriers);
  await seedOnboardingForLinda(carriers);
  const contactIds = await seedContacts();
  await seedPipelineAndDeals(contactIds);
  await seedCommissions(carriers, contactIds);

  log("[seed] done. Demo org id:", DEMO_ORG_ID);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
