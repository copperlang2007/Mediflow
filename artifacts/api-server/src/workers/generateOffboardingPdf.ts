/**
 * Generate Offboarding Report Worker.
 *
 * Triggered when an agent is set to "offboarding" or "offboarded" status.
 * Aggregates agent compliance data (profile, licenses, certifications, AHIP,
 * open tasks) into a structured HTML report, stores it in object storage via
 * the ObjectStorageService, and creates a documents table record for audit trail.
 *
 * Note: The report is stored as an HTML file (MIME: text/html). A PDF-rendering
 * step can be added later by piping the HTML through a headless browser (e.g.
 * Puppeteer) — the worker interface and document record format are already
 * correct for that upgrade path.
 */

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
} from "@workspace/db";
import { type GenerateOffboardingPdfPayload } from "../lib/jobs";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";
import { logger } from "../lib/logger";

const objectStorage = new ObjectStorageService();

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().split("T")[0];
}

function buildHtmlReport(data: {
  agent: Record<string, unknown>;
  licenses: Array<Record<string, unknown>>;
  certifications: Array<Record<string, unknown>>;
  ahipRecords: Array<Record<string, unknown>>;
  openTasks: Array<Record<string, unknown>>;
  offboardDate: string;
}): string {
  const { agent, licenses, certifications, ahipRecords, openTasks, offboardDate } = data;

  const licenseRows = licenses
    .map(
      (l) =>
        `<tr><td>${l.stateCode}</td><td>${l.licenseType}</td><td>${l.licenseNumber ?? "—"}</td>` +
        `<td>${l.status}</td><td>${formatDate(l.expiresAt as Date)}</td></tr>`,
    )
    .join("\n");

  const certRows = certifications
    .map(
      (c) =>
        `<tr><td>${c.carrierName ?? c.carrierId}</td><td>${c.certType}</td>` +
        `<td>${c.status}</td><td>${formatDate(c.expiresAt as Date)}</td></tr>`,
    )
    .join("\n");

  const ahipRows = ahipRecords
    .map(
      (a) =>
        `<tr><td>${a.certificationYear}</td><td>${a.status}</td>` +
        `<td>${formatDate(a.completedAt as Date)}</td></tr>`,
    )
    .join("\n");

  const taskRows = openTasks
    .map(
      (t) =>
        `<tr><td>${String(t.title).replace(/</g, "&lt;")}</td>` +
        `<td>${t.status}</td><td>${t.priority}</td>` +
        `<td>${formatDate(t.dueDate as Date)}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Agent Offboarding Report — ${agent.firstName} ${agent.lastName}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #111; }
    h1 { color: #1a365d; }
    h2 { color: #2b4c7e; margin-top: 32px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
    th { background: #e8f0fe; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 32px; margin: 16px 0; }
    .meta dt { font-weight: bold; }
    .meta dd { margin: 0; }
  </style>
</head>
<body>
  <h1>Agent Offboarding Report</h1>
  <p><strong>Generated:</strong> ${new Date().toISOString()} &nbsp;|&nbsp;
     <strong>Offboard Date:</strong> ${offboardDate}</p>

  <h2>Agent Profile</h2>
  <dl class="meta">
    <dt>Full Name</dt><dd>${agent.firstName} ${agent.lastName}</dd>
    <dt>NPN</dt><dd>${agent.npn ?? "—"}</dd>
    <dt>Email</dt><dd>${agent.email ?? "—"}</dd>
    <dt>Phone</dt><dd>${agent.phone ?? "—"}</dd>
    <dt>Status</dt><dd>${agent.status}</dd>
    <dt>Hire Date</dt><dd>${formatDate(agent.hireDate as Date)}</dd>
    <dt>Offboard Date</dt><dd>${formatDate(agent.offboardDate as Date)}</dd>
  </dl>

  <h2>State Licenses (${licenses.length})</h2>
  ${
    licenses.length > 0
      ? `<table>
    <tr><th>State</th><th>Type</th><th>License #</th><th>Status</th><th>Expires</th></tr>
    ${licenseRows}
  </table>`
      : "<p><em>No license records.</em></p>"
  }

  <h2>Carrier Certifications (${certifications.length})</h2>
  ${
    certifications.length > 0
      ? `<table>
    <tr><th>Carrier</th><th>Type</th><th>Status</th><th>Expires</th></tr>
    ${certRows}
  </table>`
      : "<p><em>No certification records.</em></p>"
  }

  <h2>AHIP Records (${ahipRecords.length})</h2>
  ${
    ahipRecords.length > 0
      ? `<table>
    <tr><th>Year</th><th>Status</th><th>Completed</th></tr>
    ${ahipRows}
  </table>`
      : "<p><em>No AHIP records.</em></p>"
  }

  <h2>Open Tasks at Offboarding (${openTasks.length})</h2>
  ${
    openTasks.length > 0
      ? `<table>
    <tr><th>Title</th><th>Status</th><th>Priority</th><th>Due Date</th></tr>
    ${taskRows}
  </table>`
      : "<p><em>No open tasks.</em></p>"
  }
</body>
</html>`;
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

  const currentYear = new Date().getFullYear();

  const [licenses, certifications, ahipRecords, openTasks] = await Promise.all([
    db.select().from(stateLicensesTable).where(eq(stateLicensesTable.agentId, agentId)),
    db
      .select()
      .from(carrierCertificationsTable)
      .where(eq(carrierCertificationsTable.agentId, agentId)),
    db
      .select()
      .from(ahipRecordsTable)
      .where(eq(ahipRecordsTable.agentId, agentId))
      .orderBy(ahipRecordsTable.certificationYear),
    db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.agentId, agentId),
          eq(taskInstancesTable.status, "open"),
        ),
      ),
  ]);

  const html = buildHtmlReport({
    agent: agent as unknown as Record<string, unknown>,
    licenses: licenses as unknown as Array<Record<string, unknown>>,
    certifications: certifications as unknown as Array<Record<string, unknown>>,
    ahipRecords: ahipRecords as unknown as Array<Record<string, unknown>>,
    openTasks: openTasks as unknown as Array<Record<string, unknown>>,
    offboardDate,
  });

  const filename = `offboarding-report-${agentId}-${offboardDate}.html`;
  const content = Buffer.from(html, "utf-8");

  let storageKey: string;
  try {
    storageKey = await objectStorage.uploadDocument(content, filename, orgId, {
      contentType: "text/html; charset=utf-8",
      aclRules: [
        {
          group: { type: ObjectAccessGroupType.ORG_MEMBER, id: orgId },
          permission: ObjectPermission.READ,
        },
      ],
    });
  } catch (err) {
    logger.error({ err, agentId }, "Failed to upload offboarding report to object storage");
    throw err;
  }

  await db.insert(documentsTable).values({
    id: randomUUID(),
    orgId,
    agentId,
    name: `Offboarding Report — ${agent.firstName} ${agent.lastName} (${offboardDate})`,
    category: "offboarding",
    storageKey,
    fileSizeBytes: content.byteLength,
    mimeType: "text/html",
    uploadedBy: null,
  });

  logger.info(
    { agentId, orgId, storageKey },
    "Offboarding report generated and stored",
  );
}
