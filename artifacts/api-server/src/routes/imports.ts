/**
 * Data Migration Import routes.
 * Supports Monday.com, GoHighLevel, and generic CSV contact imports.
 * Uses multer for multipart file upload + streaming CSV parse.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, ne, or, desc, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  contactsTable,
  leadsTable,
  importJobsTable,
  activitiesTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  taskInstancesTable,
  dealsTable,
  pipelineStagesTable,
  pipelinesTable,
} from "@workspace/db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";
import { randomUUID } from "crypto";
import multer from "multer";
import { parseCsvTolerant, CsvFileError, type TolerantCsvResult } from "../lib/csvImport";
import { STALE_MINUTES, staleProcessingJobs } from "../workers/importRowsSweep";
import {
  CONTACT_TARGET_FIELDS,
  ROW_NUMBER_KEY,
  parseDuplicateAction,
  prepareRowsForQueue,
  previewContactImport,
  processCsvContactImport,
  suggestContactField,
} from "../lib/contactImport";

// The background worker imports this from here (see workers/importProcessing.ts).
export { processCsvContactImport };

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// On startup: mark jobs orphaned by a prior crash/restart as "failed", dropping
// their queued rows — those hold plaintext PHI (names, DOBs, addresses) and a
// failed job never reads them again. Only jobs with no recent worker progress:
// during a rolling deploy another instance may still be running an import.
void db.update(importJobsTable)
  .set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` })
  .where(or(
    staleProcessingJobs(new Date(Date.now() - STALE_MINUTES * 60_000)),
    // Monday / GHL import workers don't record a heartbeat yet: they keep the
    // previous behavior of being failed at startup.
    and(eq(importJobsTable.status, "processing"), ne(importJobsTable.importType, "csv_contacts")),
  ))
  .catch((err) => {
    logger.error({ err }, "imports: failed to mark orphaned import jobs as failed on startup");
    captureWorkerError(err, { worker: "imports", phase: "startup-cleanup" });
  });

function parseCSV(buffer: Buffer): TolerantCsvResult {
  return parseCsvTolerant(buffer);
}

/**
 * Parse the uploaded file, or answer 400 with a message the admin can act on.
 * Row-level problems never land here: they come back in `issues` so one bad
 * row no longer fails the whole file.
 */
function parseUpload(req: Request, res: Response, route: string): TolerantCsvResult | null {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return null; }
  try {
    return parseCSV(req.file.buffer);
  } catch (err) {
    if (err instanceof CsvFileError) { res.status(400).json({ error: err.message }); return null; }
    logger.error({ err }, "imports: failed to parse CSV upload");
    captureWorkerError(err, { worker: "imports", route });
    res.status(400).json({ error: "Failed to parse CSV. Please ensure the file is a valid CSV export." });
    return null;
  }
}

function parseMapping(req: Request): Record<string, string> {
  if (!req.body.mapping) return {};
  try {
    const m = JSON.parse(req.body.mapping as string) as unknown;
    return m && typeof m === "object" ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Row-level parse problems, in the shape the validate endpoints return. */
function parseIssueErrors(parsed: TolerantCsvResult) {
  return parsed.issues.map((i) => ({ row: i.row, field: i.field, message: i.message, severity: i.severity }));
}

function withRowNumbers(parsed: TolerantCsvResult): Record<string, string>[] {
  return parsed.rows.map((r, i) => ({ ...r, [ROW_NUMBER_KEY]: String(parsed.rowNumbers[i]) }));
}

const US_STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);

// ─── Monday.com Importer ──────────────────────────────────────────────────────

// Step 1: Upload & parse CSV — return headers + sample rows for mapping
router.post(
  "/imports/monday/upload",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUpload(req, res, "monday/upload");
    if (!parsed) return;
    {
      const { headers, rows } = parsed;
      const sample = rows.slice(0, 5);

      // Suggested Monday.com → platform field mapping
      const suggestedMapping: Record<string, string> = {};
      for (const h of headers) {
        const hl = h.toLowerCase().replace(/\s+/g, "_");
        if (hl.includes("name") && !hl.includes("last") && !hl.includes("first")) suggestedMapping[h] = "fullName";
        else if (hl.includes("first")) suggestedMapping[h] = "firstName";
        else if (hl.includes("last")) suggestedMapping[h] = "lastName";
        else if (hl.includes("email")) suggestedMapping[h] = "email";
        else if (hl.includes("phone")) suggestedMapping[h] = "phone";
        else if (hl.includes("npn")) suggestedMapping[h] = "npn";
        else if (hl.includes("state") && hl.includes("licens")) suggestedMapping[h] = "licenseState";
        else if (hl.includes("status")) suggestedMapping[h] = "status";
        else if (hl.includes("hire") || hl.includes("start")) suggestedMapping[h] = "hireDate";
        else if (hl.includes("manager")) suggestedMapping[h] = "managerName";
        else if (hl.includes("carrier")) suggestedMapping[h] = "carrierName";
        else if (hl.includes("task") || hl.includes("action")) suggestedMapping[h] = "taskTitle";
        else suggestedMapping[h] = "";
      }

      res.json({
        headers,
        sampleRows: sample,
        totalRows: rows.length,
        suggestedMapping,
        targetFields: [
          { field: "firstName", label: "First Name", required: true },
          { field: "lastName", label: "Last Name", required: true },
          { field: "email", label: "Email" },
          { field: "phone", label: "Phone" },
          { field: "npn", label: "NPN (National Producer Number)" },
          { field: "status", label: "Agent Status" },
          { field: "hireDate", label: "Hire Date" },
          { field: "managerName", label: "Manager Name" },
          { field: "licenseState", label: "License State" },
          { field: "licenseType", label: "License Type" },
          { field: "taskTitle", label: "Task Title" },
          { field: "notes", label: "Notes / Description" },
          { field: "fullName", label: "Full Name (will be split)" },
        ],
        parseIssues: parseIssueErrors(parsed),
      });
    }
  },
);

// Step 2: Validate mapping + preview errors
router.post(
  "/imports/monday/validate",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "monday/validate");
    if (!parsed) return;
    const mapping = parseMapping(req);

    const { rows, rowNumbers } = parsed;
    const validationErrors: { row: number; field: string; message: string; value?: string; severity?: string }[] = parseIssueErrors(parsed);

    // Pre-compute column lookups
    const firstNameCol = Object.keys(mapping).find((k) => mapping[k] === "firstName");
    const lastNameCol = Object.keys(mapping).find((k) => mapping[k] === "lastName");
    const fullNameCol = Object.keys(mapping).find((k) => mapping[k] === "fullName");
    const stateCol = Object.keys(mapping).find((k) => mapping[k] === "licenseState");
    const npnCol = Object.keys(mapping).find((k) => mapping[k] === "npn");

    // Collect all non-empty NPNs for duplicate checks
    const csvNpns = npnCol
      ? rows.map((r) => r[npnCol]?.trim()).filter((n): n is string => !!n)
      : [];

    // Detect intra-CSV NPN duplicates
    const csvNpnSeen = new Set<string>();
    const csvNpnDuplicates = new Set<string>();
    for (const n of csvNpns) {
      if (csvNpnSeen.has(n)) csvNpnDuplicates.add(n);
      else csvNpnSeen.add(n);
    }

    // Detect NPNs already in DB for this org
    let dbNpnSet = new Set<string>();
    if (csvNpns.length > 0) {
      const existing = await db
        .select({ npn: agentsTable.npn })
        .from(agentsTable)
        .where(and(eq(agentsTable.orgId, authReq.orgId), inArray(agentsTable.npn, csvNpns)));
      dbNpnSet = new Set(existing.map((a) => a.npn).filter((n): n is string => !!n));
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNo = rowNumbers[i]!;

      const firstName = firstNameCol ? row[firstNameCol]?.trim() : fullNameCol ? row[fullNameCol]?.split(" ")[0] : "";
      const lastName = lastNameCol ? row[lastNameCol]?.trim() : fullNameCol ? row[fullNameCol]?.split(" ").slice(1).join(" ") : "";

      if (!firstName) validationErrors.push({ row: rowNo, field: "firstName", message: "First name is required" });
      if (!lastName) validationErrors.push({ row: rowNo, field: "lastName", message: "Last name is required" });

      if (stateCol && row[stateCol]) {
        const state = row[stateCol].toUpperCase().trim();
        if (!US_STATES.has(state)) validationErrors.push({ row: rowNo, field: "licenseState", message: `Invalid state code: ${state}`, value: state });
      }

      // NPN duplicate validation
      if (npnCol) {
        const npn = row[npnCol]?.trim();
        if (npn) {
          if (csvNpnDuplicates.has(npn)) {
            validationErrors.push({ row: rowNo, field: "npn", message: `Duplicate NPN within file: ${npn}`, value: npn });
          } else if (dbNpnSet.has(npn)) {
            validationErrors.push({ row: rowNo, field: "npn", message: `NPN already exists in system: ${npn}`, value: npn });
          }
        }
      }
    }

    res.json({
      totalRows: rows.length,
      errorCount: validationErrors.length,
      validRows: rows.length - new Set(validationErrors.filter((e) => !e.severity).map((e) => e.row)).size,
      errors: validationErrors.slice(0, 200),
      duplicateNpns: csvNpnDuplicates.size + dbNpnSet.size,
    });
  },
);

// Step 3: Confirm + start background import
router.post(
  "/imports/monday/confirm",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "monday/confirm");
    if (!parsed) return;
    const mapping = parseMapping(req);

    const rows = withRowNumbers(parsed);
    const jobId = randomUUID();

    await db.insert(importJobsTable).values({
      id: jobId,
      orgId: authReq.orgId,
      userId: authReq.userId,
      importType: "monday_com",
      status: "processing",
      totalRows: rows.length,
      columnMapping: mapping as Record<string, unknown>,
      options: { rows, mapping } as Record<string, unknown>,
      fileName: req.file!.originalname,
    });

    await enqueue(JOB_NAMES.IMPORT_MONDAY, { jobId });

    res.json({ jobId, totalRows: rows.length });
  },
);

async function persistProgress(jobId: string, processedRows: number, errorCount: number, errorList: unknown[]) {
  const alive = await db.update(importJobsTable).set({
    processedRows,
    errorCount,
    errors: errorList as Record<string, unknown>[],
  }).where(and(eq(importJobsTable.id, jobId), eq(importJobsTable.status, "processing")))
    .returning({ id: importJobsTable.id });
  if (alive.length === 0) logger.warn({ jobId }, "imports: job is no longer processing; progress not recorded");
}

export async function processMondayImport(jobId: string, orgId: string, rows: Record<string, string>[], mapping: Record<string, string>) {
  let created = 0, errors = 0;
  const errorList: unknown[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = Number(row[ROW_NUMBER_KEY]) || i + 2;
    try {
      const get = (field: string) => {
        const col = Object.keys(mapping).find((k) => mapping[k] === field);
        return col ? (row[col] ?? "").trim() : "";
      };

      let firstName = get("firstName");
      let lastName = get("lastName");
      const fullName = get("fullName");
      if (!firstName && fullName) { firstName = fullName.split(" ")[0] ?? ""; lastName = fullName.split(" ").slice(1).join(" "); }
      if (!firstName || !lastName) { errors++; errorList.push({ row: rowNo, message: "Missing name" }); continue; }

      const email = get("email") || null;
      const phone = get("phone") || null;
      const npn = get("npn") || null;
      const statusRaw = get("status").toLowerCase();
      const status = ["onboarding", "active", "suspended", "offboarding", "offboarded"].includes(statusRaw) ? statusRaw : "onboarding";
      const hireRaw = get("hireDate");
      const hireDate = hireRaw ? new Date(hireRaw) : null;

      // Check duplicate by email
      if (email) {
        const [existing] = await db.select({ id: agentsTable.id }).from(agentsTable).where(and(eq(agentsTable.orgId, orgId), eq(agentsTable.email, email))).limit(1);
        if (existing) {
          // Update existing agent instead of skipping — merge strategy
          await db.update(agentsTable).set({
            ...(npn && { npn }),
            ...(phone && { phone }),
            ...(hireDate && !isNaN(hireDate.getTime()) && { hireDate }),
          }).where(eq(agentsTable.id, existing.id));
          // Still attempt to import license / carrier below using existing agent id
          await importMondayAgentRelations(get, orgId, existing.id);
          created++; // count as created/updated
          continue;
        }
      }

      const agentId = randomUUID();
      await db.insert(agentsTable).values({
        id: agentId,
        orgId,
        firstName,
        lastName,
        email: email ?? "",
        phone: phone ?? undefined,
        npn: npn ?? undefined,
        status: status as "onboarding" | "active" | "suspended" | "offboarding" | "offboarded",
        hireDate: hireDate && !isNaN(hireDate.getTime()) ? hireDate : undefined,
      });

      // Import related records: licenses, carrier certs, tasks
      await importMondayAgentRelations(get, orgId, agentId);

      created++;
    } catch (err) {
      errors++;
      errorList.push({ row: rowNo, message: "Failed to create agent record" });
      logger.error({ err, jobId, row: rowNo }, "imports: failed to create Monday agent record");
      captureWorkerError(err, { worker: "imports", route: "monday/confirm", jobId, row: rowNo });
    }

    // Persist progress to DB every 50 rows (restart-safe)
    if (i % 50 === 0) {
      await persistProgress(jobId, i + 1, errors, errorList);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const done = await db.update(importJobsTable).set({
    status: "completed",
    processedRows: rows.length,
    createdCount: created,
    errorCount: errors,
    errors: errorList as Record<string, unknown>[],
    completedAt: new Date(),
  }).where(and(eq(importJobsTable.id, jobId), eq(importJobsTable.status, "processing")))
    .returning({ id: importJobsTable.id });
  if (done.length === 0) logger.warn({ jobId }, "imports: job was failed by cleanup before it finished; left as failed");
}

async function importMondayAgentRelations(get: (f: string) => string, orgId: string, agentId: string) {
  // State license import
  const licenseState = get("licenseState").toUpperCase();
  const licenseType = get("licenseType") || "Life and Health";
  const licenseNumber = get("licenseNumber") || null;
  const licenseExpiryRaw = get("licenseExpiry");
  const licenseStatusRaw = get("licenseStatus").toLowerCase();

  if (licenseState && US_STATES.has(licenseState)) {
    const licenseExpiry = licenseExpiryRaw ? new Date(licenseExpiryRaw) : null;
    const licenseStatus = ["active", "expired", "pending", "cancelled"].includes(licenseStatusRaw) ? licenseStatusRaw : "active";
    // Upsert by (agentId, stateCode, licenseType)
    const [existingLic] = await db.select({ id: stateLicensesTable.id })
      .from(stateLicensesTable)
      .where(and(eq(stateLicensesTable.agentId, agentId), eq(stateLicensesTable.stateCode, licenseState), eq(stateLicensesTable.licenseType, licenseType)))
      .limit(1);
    if (!existingLic) {
      await db.insert(stateLicensesTable).values({
        id: randomUUID(),
        agentId,
        stateCode: licenseState,
        licenseType,
        licenseNumber: licenseNumber ?? undefined,
        status: licenseStatus as "active" | "expired" | "pending" | "suspended" | "not_appointed",
        expiryDate: licenseExpiry && !isNaN(licenseExpiry.getTime()) ? licenseExpiry : undefined,
      });
    }
  }

  // Carrier certification import
  const carrierName = get("carrierName");
  if (carrierName) {
    const [carrier] = await db.select({ id: carriersTable.id })
      .from(carriersTable)
      .where(and(eq(carriersTable.orgId, orgId), eq(carriersTable.name, carrierName)))
      .limit(1);
    if (carrier) {
      const certYear = new Date().getFullYear();
      const [existingCert] = await db.select({ id: carrierCertificationsTable.id })
        .from(carrierCertificationsTable)
        .where(and(eq(carrierCertificationsTable.agentId, agentId), eq(carrierCertificationsTable.carrierId, carrier.id), eq(carrierCertificationsTable.certificationYear, certYear)))
        .limit(1);
      if (!existingCert) {
        await db.insert(carrierCertificationsTable).values({
          id: randomUUID(),
          agentId,
          carrierId: carrier.id,
          certificationYear: certYear,
          status: "not_started",
        });
      }
    }
  }

  // Task import — create a task_instance if taskTitle is provided
  const taskTitle = get("taskTitle");
  const taskNotes = get("notes");
  if (taskTitle) {
    await db.insert(taskInstancesTable).values({
      id: randomUUID(),
      orgId,
      agentId,
      title: taskTitle,
      description: taskNotes || undefined,
      status: "open",
      priority: "medium",
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // default 7 days
    });
  }
}

// Step 4: SSE progress — org-scoped to prevent IDOR across orgs
router.get(
  "/imports/progress/:jobId",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0]! : req.params.jobId;

    // Pre-flight org ownership check (DB-only, no in-memory map)
    const [preflight] = await db.select({ orgId: importJobsTable.orgId }).from(importJobsTable)
      .where(and(eq(importJobsTable.id, jobId), eq(importJobsTable.orgId, authReq.orgId))).limit(1);
    if (!preflight) { res.status(404).json({ error: "Job not found" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Always stream progress from DB — restart-safe
    const interval = setInterval(async () => {
      const [job] = await db.select().from(importJobsTable)
        .where(and(eq(importJobsTable.id, jobId), eq(importJobsTable.orgId, authReq.orgId))).limit(1);
      if (!job) { send({ error: "Job not found" }); clearInterval(interval); res.end(); return; }
      send({ status: job.status, processed: job.processedRows, total: job.totalRows, errorCount: job.errorCount });
      if (job.status === "completed" || job.status === "failed") { clearInterval(interval); res.end(); }
    }, 500);

    req.on("close", () => clearInterval(interval));
  },
);

// ─── GoHighLevel Importer ─────────────────────────────────────────────────────

router.post(
  "/imports/ghl/upload",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUpload(req, res, "ghl/upload");
    if (!parsed) return;
    {
      const { headers, rows } = parsed;
      const sample = rows.slice(0, 5);

      const suggestedMapping: Record<string, string> = {};
      for (const h of headers) {
        const hl = h.toLowerCase().replace(/[\s_-]+/g, "_");
        if (hl === "first_name" || hl === "firstname") suggestedMapping[h] = "firstName";
        else if (hl === "last_name" || hl === "lastname") suggestedMapping[h] = "lastName";
        else if (hl.includes("email")) suggestedMapping[h] = "email";
        else if (hl.includes("phone") || hl === "mobile") suggestedMapping[h] = "phone";
        else if (hl === "dob" || hl.includes("birth")) suggestedMapping[h] = "dob";
        else if (hl.includes("tag")) suggestedMapping[h] = "tags";
        else if (hl.includes("note")) suggestedMapping[h] = "notes";
        else if (hl.includes("source") || hl.includes("lead_source")) suggestedMapping[h] = "leadSource";
        else if (hl.includes("stage") || hl.includes("pipeline")) suggestedMapping[h] = "pipelineStage";
        else if (hl.includes("assigned") || hl.includes("owner")) suggestedMapping[h] = "assignedAgentEmail";
        else if (hl.includes("state") || hl === "st") suggestedMapping[h] = "stateCode";
        else if (hl.includes("zip")) suggestedMapping[h] = "zipCode";
        else suggestedMapping[h] = "";
      }

      res.json({
        headers,
        sampleRows: sample,
        totalRows: rows.length,
        suggestedMapping,
        targetFields: [
          { field: "firstName", label: "First Name", required: true },
          { field: "lastName", label: "Last Name", required: true },
          { field: "email", label: "Email" },
          { field: "phone", label: "Phone" },
          { field: "dob", label: "Date of Birth" },
          { field: "stateCode", label: "State Code" },
          { field: "zipCode", label: "ZIP Code" },
          { field: "leadSource", label: "Lead Source" },
          { field: "tags", label: "Tags (comma-separated)" },
          { field: "notes", label: "Notes" },
          { field: "pipelineStage", label: "Pipeline Stage Name" },
          { field: "assignedAgentEmail", label: "Assigned Agent (email)" },
        ],
        parseIssues: parseIssueErrors(parsed),
      });
    }
  },
);

router.post(
  "/imports/ghl/validate",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "ghl/validate");
    if (!parsed) return;
    const mapping = parseMapping(req);

    const { rows, rowNumbers } = parsed;
    const errors: { row: number; field: string; message: string; severity?: string }[] = parseIssueErrors(parsed);

    // Check for duplicate phone/email within existing contacts
    const emails = rows.map((r) => {
      const col = Object.keys(mapping).find((k) => mapping[k] === "email");
      return col ? r[col]?.trim() : null;
    }).filter(Boolean) as string[];

    const phones = rows.map((r) => {
      const col = Object.keys(mapping).find((k) => mapping[k] === "phone");
      return col ? r[col]?.trim() : null;
    }).filter(Boolean) as string[];

    const [existingEmails, existingPhones] = await Promise.all([
      emails.length > 0
        ? db.select({ email: contactsTable.email }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.email, emails)))
        : Promise.resolve([]),
      phones.length > 0
        ? db.select({ phone: contactsTable.phone }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), inArray(contactsTable.phone, phones)))
        : Promise.resolve([]),
    ]);

    const existingEmailSet = new Set(existingEmails.map((e) => e.email).filter(Boolean));
    const existingPhoneSet = new Set(existingPhones.map((p) => p.phone).filter(Boolean));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNo = rowNumbers[i]!;
      const firstNameCol = Object.keys(mapping).find((k) => mapping[k] === "firstName");
      const lastNameCol = Object.keys(mapping).find((k) => mapping[k] === "lastName");
      if (firstNameCol && !row[firstNameCol]?.trim()) errors.push({ row: rowNo, field: "firstName", message: "First name required" });
      if (lastNameCol && !row[lastNameCol]?.trim()) errors.push({ row: rowNo, field: "lastName", message: "Last name required" });

      const emailCol = Object.keys(mapping).find((k) => mapping[k] === "email");
      const phoneCol = Object.keys(mapping).find((k) => mapping[k] === "phone");
      if (emailCol && row[emailCol] && existingEmailSet.has(row[emailCol].trim())) {
        errors.push({ row: rowNo, field: "email", message: `Duplicate email: ${row[emailCol].trim()}` });
      }
      if (phoneCol && row[phoneCol] && existingPhoneSet.has(row[phoneCol].trim())) {
        errors.push({ row: rowNo, field: "phone", message: `Duplicate phone: ${row[phoneCol].trim()}` });
      }
    }

    res.json({ totalRows: rows.length, errorCount: errors.length, validRows: rows.length - new Set(errors.filter((e) => !e.severity).map((e) => e.row)).size, errors: errors.slice(0, 200), duplicateEmails: existingEmailSet.size, duplicatePhones: existingPhoneSet.size });
  },
);

router.post(
  "/imports/ghl/confirm",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "ghl/confirm");
    if (!parsed) return;
    const mapping = parseMapping(req);
    const duplicateAction = (req.body.duplicateAction as string) || "skip"; // skip|merge|create

    const rows = withRowNumbers(parsed);
    const jobId = randomUUID();

    await db.insert(importJobsTable).values({
      id: jobId, orgId: authReq.orgId, userId: authReq.userId,
      importType: "gohighlevel", status: "processing", totalRows: rows.length,
      columnMapping: mapping as Record<string, unknown>,
      options: { rows, mapping, duplicateAction } as Record<string, unknown>,
      fileName: req.file!.originalname,
    });

    await enqueue(JOB_NAMES.IMPORT_GHL, { jobId });

    res.json({ jobId, totalRows: rows.length });
  },
);

export async function processGhlImport(jobId: string, orgId: string, rows: Record<string, string>[], mapping: Record<string, string>, duplicateAction: string) {
  let created = 0, updated = 0, skipped = 0, errors = 0;
  const errorList: unknown[] = [];

  // Pre-load pipelines for deal creation
  const allPipelines = await db.select({ id: pipelinesTable.id }).from(pipelinesTable).where(eq(pipelinesTable.orgId, orgId));
  const pipelineIds = allPipelines.map((p) => p.id);
  const allStages = pipelineIds.length > 0
    ? await db.select({ id: pipelineStagesTable.id, name: pipelineStagesTable.name, pipelineId: pipelineStagesTable.pipelineId })
        .from(pipelineStagesTable).where(inArray(pipelineStagesTable.pipelineId, pipelineIds))
    : [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = Number(row[ROW_NUMBER_KEY]) || i + 2;
    try {
      const get = (field: string) => {
        const col = Object.keys(mapping).find((k) => mapping[k] === field);
        return col ? (row[col] ?? "").trim() : "";
      };

      const firstName = get("firstName");
      const lastName = get("lastName");
      if (!firstName || !lastName) { errors++; errorList.push({ row: rowNo, message: "Missing name" }); continue; }

      const email = get("email") || null;
      const phone = get("phone") || null;
      const tagsRaw = get("tags");
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const notes = get("notes") || null;
      const stateCode = get("stateCode") || null;
      const zipCode = get("zipCode") || null;
      const leadSource = get("leadSource") || null;
      const dobRaw = get("dob");
      const pipelineStageRaw = get("pipelineStage");

      // Duplicate check: composite key (email AND phone) when both present; single-field otherwise
      let existingContact: { id: string } | null = null;
      if (email && phone) {
        // Both identifiers: require both to match (prevents false merges from shared family contacts)
        const [existing] = await db.select({ id: contactsTable.id }).from(contactsTable)
          .where(and(eq(contactsTable.orgId, orgId), eq(contactsTable.email, email), eq(contactsTable.phone, phone)))
          .limit(1);
        existingContact = existing ?? null;
      } else if (email) {
        const [existing] = await db.select({ id: contactsTable.id }).from(contactsTable)
          .where(and(eq(contactsTable.orgId, orgId), eq(contactsTable.email, email)))
          .limit(1);
        existingContact = existing ?? null;
      } else if (phone) {
        const [existing] = await db.select({ id: contactsTable.id }).from(contactsTable)
          .where(and(eq(contactsTable.orgId, orgId), eq(contactsTable.phone, phone)))
          .limit(1);
        existingContact = existing ?? null;
      }

      if (existingContact) {
        if (duplicateAction === "skip") { skipped++; continue; }
        if (duplicateAction === "merge") {
          await db.update(contactsTable).set({
            ...(stateCode && { stateCode }),
            ...(zipCode && { zipCode }),
            ...(leadSource && { leadSource }),
            ...(tags.length > 0 && { tags }),
            updatedAt: new Date(),
          }).where(eq(contactsTable.id, existingContact.id));
          updated++;
          if (notes) {
            await db.insert(activitiesTable).values({ id: randomUUID(), orgId, contactId: existingContact.id, type: "note", body: notes });
          }
          // Still try to create deal if stage is mapped
          if (pipelineStageRaw) await createGhlDeal(orgId, existingContact.id, pipelineStageRaw, allStages);
          continue;
        }
        // create_new falls through
      }

      const contactId = randomUUID();
      await db.insert(contactsTable).values({
        id: contactId,
        orgId,
        firstName,
        lastName,
        email: email ?? undefined,
        phone: phone ?? undefined,
        stateCode: stateCode ?? undefined,
        zipCode: zipCode ?? undefined,
        leadSource: leadSource ?? undefined,
        tags: tags.length > 0 ? tags : undefined,
        dob: dobRaw && !isNaN(new Date(dobRaw).getTime()) ? new Date(dobRaw) : undefined,
        status: "lead",
      });

      if (notes) {
        await db.insert(activitiesTable).values({ id: randomUUID(), orgId, contactId, type: "note", body: notes });
      }

      // Create deal if pipelineStage is mapped
      if (pipelineStageRaw) await createGhlDeal(orgId, contactId, pipelineStageRaw, allStages);

      created++;
    } catch (err) {
      errors++;
      errorList.push({ row: rowNo, message: "Failed to create contact" });
      logger.error({ err, jobId, row: rowNo }, "imports: failed to create GHL contact");
      captureWorkerError(err, { worker: "imports", route: "ghl/confirm", jobId, row: rowNo });
    }

    if (i % 50 === 0) {
      await persistProgress(jobId, i + 1, errors, errorList);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const done = await db.update(importJobsTable).set({
    status: "completed", processedRows: rows.length, createdCount: created,
    updatedCount: updated, skippedCount: skipped, errorCount: errors,
    errors: errorList as Record<string, unknown>[], completedAt: new Date(),
  }).where(and(eq(importJobsTable.id, jobId), eq(importJobsTable.status, "processing")))
    .returning({ id: importJobsTable.id });
  if (done.length === 0) logger.warn({ jobId }, "imports: job was failed by cleanup before it finished; left as failed");
}

async function createGhlDeal(orgId: string, contactId: string, pipelineStageRaw: string, allStages: { id: string; name: string; pipelineId: string }[]) {
  const matchedStage = allStages.find((s) => s.name.toLowerCase() === pipelineStageRaw.toLowerCase());
  if (!matchedStage) return;
  await db.insert(dealsTable).values({
    id: randomUUID(),
    orgId,
    contactId,
    pipelineId: matchedStage.pipelineId,
    stageId: matchedStage.id,
    title: "GHL Import",
    status: "open",
  });
}

// ─── Generic CSV Contact Importer ─────────────────────────────────────────────
// Contacts + Medicare coverage. Row interpretation, dedupe and the write path
// live in lib/contactImport.ts so validate and the worker share one rule set.

router.post(
  "/imports/contacts/upload",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUpload(req, res, "contacts/upload");
    if (!parsed) return;
    const { headers, rows } = parsed;
    const suggestedMapping: Record<string, string> = {};
    const taken = new Set<string>();
    for (const h of headers) {
      const field = suggestContactField(h);
      // One column per target field; a second "Phone" column stays unmapped.
      suggestedMapping[h] = field && !taken.has(field) ? field : "";
      if (field) taken.add(field);
    }
    res.json({
      headers,
      sampleRows: rows.slice(0, 5),
      totalRows: rows.length,
      suggestedMapping,
      targetFields: CONTACT_TARGET_FIELDS,
      parseIssues: parseIssueErrors(parsed),
    });
  },
);

// Step 2: validate mapping + detect duplicates (same response shape as monday/ghl validate)
router.post(
  "/imports/contacts/validate",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "contacts/validate");
    if (!parsed) return;
    const mapping = parseMapping(req);
    const duplicateAction = parseDuplicateAction(req.body.duplicateAction);

    const summary = await previewContactImport(authReq.orgId, parsed.rows, parsed.rowNumbers, mapping, duplicateAction);
    const all = [...parsed.issues, ...summary.issues].sort((a, b) => a.row - b.row);
    const errorCount = all.filter((e) => e.severity === "error").length;
    // Errors first so the rows that will NOT import are never cut off by the cap.
    const ordered = [...all.filter((e) => e.severity === "error"), ...all.filter((e) => e.severity === "warning")];

    res.json({
      totalRows: parsed.rows.length + parsed.issues.filter((i) => i.severity === "error").length,
      validRows: summary.validRows,
      errorCount,
      warningCount: all.length - errorCount,
      errors: ordered.slice(0, 500),
      duplicateCount: summary.duplicateCount,
      enrollmentCount: summary.enrollmentCount,
      newCarriers: summary.newCarriers,
    });
  },
);

router.post(
  "/imports/contacts/confirm",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = parseUpload(req, res, "contacts/confirm");
    if (!parsed) return;
    const mapping = parseMapping(req);
    const duplicateAction = parseDuplicateAction(req.body.duplicateAction);

    const jobId = randomUUID();
    try {
      // Encrypts the Medicare ID cells before they are persisted for the worker.
      const rows = prepareRowsForQueue(parsed.rows, parsed.rowNumbers, mapping);
      await db.insert(importJobsTable).values({
        id: jobId, orgId: authReq.orgId, userId: authReq.userId,
        importType: "csv_contacts", status: "processing", totalRows: rows.length,
        columnMapping: mapping as Record<string, unknown>,
        // parseIssues seeds the worker's report (rows that never reach it).
        // Their messages never contain cell values, so they are not PHI.
        options: { rows, mapping, duplicateAction, parseIssues: parsed.issues } as Record<string, unknown>,
        // Rows that could not be parsed never reach the worker; record them now.
        errors: parsed.issues.map((i) => ({ row: i.row, field: i.field, message: i.message })),
        errorCount: parsed.issues.filter((i) => i.severity === "error").length,
        fileName: req.file!.originalname,
      });

      const queuedId = await enqueue(JOB_NAMES.IMPORT_CSV_CONTACTS, { jobId });
      if (!queuedId) {
        await db.update(importJobsTable).set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` }).where(eq(importJobsTable.id, jobId));
        res.status(503).json({ error: "Import service is temporarily unavailable. Please retry." });
        return;
      }

      res.json({ jobId, totalRows: rows.length });
    } catch (err) {
      // If the job row was written before the failure, don't leave its queued
      // rows (plaintext PHI) behind.
      await db.update(importJobsTable)
        .set({ status: "failed", options: sql`${importJobsTable.options} - 'rows'` })
        .where(eq(importJobsTable.id, jobId))
        .catch(() => undefined);
      logger.error({ err, jobId }, "imports: failed to create CSV contact import");
      captureWorkerError(err, { worker: "imports", route: "contacts/confirm" });
      res.status(500).json({ error: "Could not create the import. Please retry or contact support." });
    }
  },
);

// ─── Import History ───────────────────────────────────────────────────────────

router.get(
  "/imports/history",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const jobs = await db.select().from(importJobsTable)
      .where(eq(importJobsTable.orgId, authReq.orgId))
      .orderBy(desc(importJobsTable.createdAt))
      .limit(100);
    res.json(jobs);
  },
);

// Error CSV download for a past import job
router.get(
  "/imports/:jobId/errors.csv",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [job] = await db.select().from(importJobsTable)
      .where(and(eq(importJobsTable.id, Array.isArray(req.params.jobId) ? req.params.jobId[0]! : req.params.jobId), eq(importJobsTable.orgId, authReq.orgId)));
    if (!job) { res.status(404).json({ error: "Not found" }); return; }

    const errors = (job.errors as { row?: number; field?: string; message?: string }[] | null) ?? [];
    const header = ["Row", "Field", "Message"];
    const rows = errors.map((e) => [String(e.row ?? ""), e.field ?? "", e.message ?? ""]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="import-errors-${job.id.slice(0, 8)}.csv"`);
    res.send(csv);
  },
);

export default router;
