/**
 * Generate Offboarding Report Worker.
 *
 * Triggered when an agent is set to "offboarding" status.
 * Aggregates agent compliance data into a structured PDF report using pdfkit,
 * stores it in object storage, and creates a documents table record.
 */

import PDFDocument from "pdfkit";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  taskInstancesTable,
  documentsTable,
  techStackAccountsTable,
  checklistRunsTable,
  checklistItemsTable,
  sql,
} from "@workspace/db";
import { type GenerateOffboardingPdfPayload } from "../lib/jobs";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";
import { logger } from "../lib/logger";

const objectStorage = new ObjectStorageService();

function fmt(d: Date | null | undefined): string {
  if (!d) return "—";
  return (d instanceof Date ? d : new Date(d as string)).toISOString().split("T")[0];
}

function calcTenure(hireDate: Date | null | undefined, offboardDate: string): string {
  if (!hireDate) return "—";
  const hire = hireDate instanceof Date ? hireDate : new Date(hireDate as string);
  const offboard = new Date(offboardDate);
  const diffMs = offboard.getTime() - hire.getTime();
  const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (parts.length === 0) parts.push(`${totalDays} day${totalDays !== 1 ? "s" : ""}`);
  return parts.join(", ");
}

async function buildPdf(data: {
  agent: Record<string, unknown>;
  licenses: Array<Record<string, unknown>>;
  certifications: Array<Record<string, unknown>>;
  ahipRecords: Array<Record<string, unknown>>;
  openTasks: Array<Record<string, unknown>>;
  techStack: Array<Record<string, unknown>>;
  releaseDocuments: Array<Record<string, unknown>>;
  offboardingSteps: Array<Record<string, unknown>>;
  offboardDate: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const {
      agent,
      licenses,
      certifications,
      ahipRecords,
      openTasks,
      techStack,
      releaseDocuments,
      offboardingSteps,
      offboardDate,
    } = data;

    // ── Colour palette ──────────────────────────────────────────────
    const NAVY = "#1a365d";
    const BLUE = "#2b4c7e";
    const LIGHT_GREY = "#f5f5f5";
    const BORDER = "#cccccc";
    const TEXT = "#111111";

    // ── Header band ─────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 72).fill(NAVY);
    doc
      .fillColor("#ffffff")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("Agent Offboarding Report", 50, 22);
    doc
      .fontSize(9)
      .font("Helvetica")
      .text(
        `Generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC   |   Offboard Date: ${offboardDate}`,
        50,
        50,
      );
    doc.fillColor(TEXT).moveDown(0.5);
    doc.y = 90;

    // ── Helper: section heading ──────────────────────────────────────
    const sectionHeading = (title: string) => {
      doc.moveDown(0.6);
      doc
        .rect(50, doc.y, doc.page.width - 100, 18)
        .fill(BLUE);
      doc
        .fillColor("#ffffff")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(title, 56, doc.y - 15, { lineBreak: false });
      doc.fillColor(TEXT).moveDown(0.4);
    };

    // ── Helper: two-column meta grid ─────────────────────────────────
    const metaRow = (label: string, value: string) => {
      const y = doc.y;
      doc.fontSize(9).font("Helvetica-Bold").text(label + ":", 56, y, { continued: false, width: 110 });
      doc.fontSize(9).font("Helvetica").text(value, 170, y, { width: 320 });
      doc.moveDown(0.15);
    };

    // ── Helper: table ────────────────────────────────────────────────
    const drawTable = (
      headers: string[],
      rows: string[][],
      colWidths: number[],
    ) => {
      const left = 50;
      const rowH = 16;
      let x = left;
      let y = doc.y + 4;

      // header row
      doc.rect(left, y, doc.page.width - 100, rowH).fill(LIGHT_GREY);
      doc.rect(left, y, doc.page.width - 100, rowH).stroke(BORDER);
      headers.forEach((h, i) => {
        doc.fillColor(TEXT).fontSize(8).font("Helvetica-Bold").text(h, x + 3, y + 4, { width: colWidths[i]! - 6, lineBreak: false });
        x += colWidths[i]!;
      });
      y += rowH;

      // data rows
      rows.forEach((row, ri) => {
        if (y + rowH > doc.page.height - 60) {
          doc.addPage();
          y = 60;
        }
        if (ri % 2 === 0) {
          doc.rect(left, y, doc.page.width - 100, rowH).fillAndStroke("#fafafa", BORDER);
        } else {
          doc.rect(left, y, doc.page.width - 100, rowH).stroke(BORDER);
        }
        x = left;
        row.forEach((cell, i) => {
          doc.fillColor(TEXT).fontSize(8).font("Helvetica").text(cell, x + 3, y + 4, { width: colWidths[i]! - 6, lineBreak: false });
          x += colWidths[i]!;
        });
        y += rowH;
      });
      doc.y = y + 6;
    };

    // ── Agent Profile ────────────────────────────────────────────────
    sectionHeading(`Agent Profile`);
    metaRow("Full Name", `${agent.firstName} ${agent.lastName}`);
    metaRow("NPN", String(agent.npn ?? "—"));
    metaRow("Email", String(agent.email ?? "—"));
    metaRow("Phone", String(agent.phone ?? "—"));
    metaRow("Status", String(agent.status ?? "—"));
    metaRow("Hire Date", fmt(agent.hireDate as Date));
    metaRow("Offboard Date", fmt(agent.offboardDate as Date));
    metaRow("Tenure", calcTenure(agent.hireDate as Date, offboardDate));

    // ── State Licenses ───────────────────────────────────────────────
    sectionHeading(`State Licenses (${licenses.length})`);
    if (licenses.length > 0) {
      drawTable(
        ["State", "Type", "License #", "Status", "Expires"],
        licenses.map((l) => [
          String(l.stateCode ?? ""),
          String(l.licenseType ?? ""),
          String(l.licenseNumber ?? "—"),
          String(l.status ?? ""),
          fmt(l.expiryDate as Date),
        ]),
        [55, 140, 110, 90, 85],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No license records.", 56).moveDown(0.3);
    }

    // ── Carrier Certifications ───────────────────────────────────────
    sectionHeading(`Carrier Certifications (${certifications.length})`);
    if (certifications.length > 0) {
      drawTable(
        ["Carrier ID", "Year", "Status", "Completed", "Expires"],
        certifications.map((c) => [
          String(c.carrierId ?? ""),
          String(c.certificationYear ?? ""),
          String(c.status ?? ""),
          fmt(c.completedDate as Date),
          fmt(c.expiryDate as Date),
        ]),
        [110, 50, 80, 90, 90],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No certification records.", 56).moveDown(0.3);
    }

    // ── AHIP Records ─────────────────────────────────────────────────
    sectionHeading(`AHIP Records (${ahipRecords.length})`);
    if (ahipRecords.length > 0) {
      drawTable(
        ["Year", "Status", "Completed"],
        ahipRecords.map((a) => [
          String(a.certificationYear ?? ""),
          String(a.status ?? ""),
          fmt(a.completedDate as Date),
        ]),
        [80, 120, 120],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No AHIP records.", 56).moveDown(0.3);
    }

    // ── Open Tasks ───────────────────────────────────────────────────
    sectionHeading(`Open Tasks at Offboarding (${openTasks.length})`);
    if (openTasks.length > 0) {
      drawTable(
        ["Title", "Status", "Priority", "Due Date"],
        openTasks.map((t) => [
          String(t.title ?? "").substring(0, 45),
          String(t.status ?? ""),
          String(t.priority ?? ""),
          fmt(t.dueDate as Date),
        ]),
        [220, 80, 80, 80],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No open tasks.", 56).moveDown(0.3);
    }

    // ── Tech Stack Deprovisioning ────────────────────────────────────
    sectionHeading(`Tech Stack Deprovisioning (${techStack.length} platforms)`);
    if (techStack.length > 0) {
      const provisioned = techStack.filter((a) => a.status === "provisioned").length;
      const deprovisioned = techStack.filter((a) => a.status === "deprovisioned").length;
      const pending = techStack.filter((a) => a.status === "pending").length;
      doc.fontSize(9).font("Helvetica")
        .text(`Provisioned: ${provisioned}  |  Deprovisioned: ${deprovisioned}  |  Pending: ${pending}`, 56)
        .moveDown(0.3);
      drawTable(
        ["Platform", "Category", "Status", "Provisioned", "Deprovisioned"],
        techStack.map((a) => [
          String(a.platformName ?? ""),
          String(a.platformCategory ?? "—"),
          String(a.status ?? ""),
          fmt(a.provisionedAt as Date),
          fmt(a.deprovisionedAt as Date),
        ]),
        [155, 90, 85, 90, 100],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No tech stack accounts configured.", 56).moveDown(0.3);
    }

    // ── Release Documents ────────────────────────────────────────────
    sectionHeading(`Release Documents (${releaseDocuments.length})`);
    if (releaseDocuments.length > 0) {
      drawTable(
        ["Document Name", "Category", "Created"],
        releaseDocuments.map((d) => [
          String(d.name ?? "").substring(0, 60),
          String(d.category ?? ""),
          fmt(d.createdAt as Date),
        ]),
        [280, 100, 90],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No release documents on file.", 56).moveDown(0.3);
    }

    // ── Offboarding Checklist Step Trace ─────────────────────────────
    sectionHeading(`Offboarding Step Trace (${offboardingSteps.length} items)`);
    if (offboardingSteps.length > 0) {
      drawTable(
        ["Step", "Status", "Completed By", "Completed At"],
        offboardingSteps.map((s) => [
          String(s.title ?? "").substring(0, 50),
          String(s.status ?? ""),
          String(s.completedByUserId ?? "—").substring(0, 30),
          s.completedAt ? fmt(s.completedAt as Date) : "—",
        ]),
        [215, 75, 130, 100],
      );
    } else {
      doc.fontSize(9).font("Helvetica-Oblique").text("No offboarding checklist steps recorded.", 56).moveDown(0.3);
    }

    // ── Footer on each page ──────────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#888888")
        .font("Helvetica")
        .text(
          `MediFlow — Confidential   |   Page ${i + 1} of ${pages.count}`,
          50,
          doc.page.height - 35,
          { align: "center", width: doc.page.width - 100 },
        );
    }

    doc.end();
  });
}

export async function generateOffboardingPdfWorker(
  data: GenerateOffboardingPdfPayload,
): Promise<void> {
  const { agentId, orgId, offboardDate } = data;

  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);

  if (!agent) {
    logger.warn({ agentId, orgId }, "Offboarding report: agent not found");
    return;
  }

  const [licenses, certifications, ahipRecords, openTasks, techStack, releaseDocuments] =
    await Promise.all([
      db.select().from(stateLicensesTable).where(eq(stateLicensesTable.agentId, agentId)),
      db.select().from(carrierCertificationsTable).where(eq(carrierCertificationsTable.agentId, agentId)),
      db
        .select()
        .from(ahipRecordsTable)
        .where(eq(ahipRecordsTable.agentId, agentId))
        .orderBy(ahipRecordsTable.certificationYear),
      db
        .select()
        .from(taskInstancesTable)
        .where(and(eq(taskInstancesTable.agentId, agentId), eq(taskInstancesTable.status, "open"))),
      db
        .select()
        .from(techStackAccountsTable)
        .where(eq(techStackAccountsTable.agentId, agentId))
        .orderBy(techStackAccountsTable.platformName),
      db
        .select()
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.agentId, agentId),
            sql`${documentsTable.category} IN ('offboarding', 'release', 'separation')`,
          ),
        )
        .orderBy(documentsTable.createdAt),
    ]);

  // Get offboarding checklist run and its items for step trace
  const [offboardingRun] = await db
    .select({ id: checklistRunsTable.id })
    .from(checklistRunsTable)
    .where(
      and(
        eq(checklistRunsTable.agentId, agentId),
        eq(checklistRunsTable.orgId, orgId),
        sql`${checklistRunsTable.type} = 'offboarding'`,
      ),
    )
    .orderBy(sql`${checklistRunsTable.startedAt} desc`)
    .limit(1);

  const offboardingSteps = offboardingRun
    ? await db
        .select()
        .from(checklistItemsTable)
        .where(eq(checklistItemsTable.runId, offboardingRun.id))
        .orderBy(checklistItemsTable.orderIndex)
    : [];

  const pdfBuffer = await buildPdf({
    agent: agent as unknown as Record<string, unknown>,
    licenses: licenses as unknown as Array<Record<string, unknown>>,
    certifications: certifications as unknown as Array<Record<string, unknown>>,
    ahipRecords: ahipRecords as unknown as Array<Record<string, unknown>>,
    openTasks: openTasks as unknown as Array<Record<string, unknown>>,
    techStack: techStack as unknown as Array<Record<string, unknown>>,
    releaseDocuments: releaseDocuments as unknown as Array<Record<string, unknown>>,
    offboardingSteps: offboardingSteps as unknown as Array<Record<string, unknown>>,
    offboardDate,
  });

  const filename = `offboarding-report-${agentId}-${offboardDate}.pdf`;

  let storageKey: string;
  try {
    storageKey = await objectStorage.uploadDocument(pdfBuffer, filename, orgId, {
      contentType: "application/pdf",
      aclRules: [
        {
          group: { type: ObjectAccessGroupType.ORG_MEMBER, id: orgId },
          permission: ObjectPermission.READ,
        },
      ],
    });
  } catch (err) {
    logger.error({ err, agentId }, "Failed to upload offboarding PDF to object storage");
    throw err;
  }

  await db.insert(documentsTable).values({
    id: randomUUID(),
    orgId,
    agentId,
    name: `Offboarding Report — ${agent.firstName} ${agent.lastName} (${offboardDate})`,
    category: "offboarding",
    storageKey,
    fileSizeBytes: pdfBuffer.byteLength,
    mimeType: "application/pdf",
    uploadedBy: null,
  });

  logger.info({ agentId, orgId, storageKey }, "Offboarding PDF report generated and stored");
}
