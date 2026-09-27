/**
 * Agent compliance score — the weighted 0–100 number shown on the agent
 * profile and the Agent Back Office.
 *
 *   licenses 40% · carrier certifications 30% · AHIP (current year) 20% ·
 *   onboarding checklist 10%
 *
 * Extracted from `GET /agents/:id/compliance-score` so the back-office view
 * computes exactly the same number. The caller must have already verified
 * that `agentId` belongs to `orgId`.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  checklistRunsTable,
  checklistItemsTable,
} from "@workspace/db";

export type ComplianceScore = {
  agentId: string;
  totalScore: number;
  licenseScore: number;
  certificationScore: number;
  ahipScore: number;
  onboardingScore: number;
  activeLicenses: number;
  totalLicenses: number;
  activeCertifications: number;
  totalCertifications: number;
  ahipCompleted: boolean;
  onboardingComplete: boolean;
  onboardingCompletedItems: number;
  onboardingTotalItems: number;
};

export async function computeComplianceScore(
  agentId: string,
  orgId: string,
  now: Date = new Date(),
): Promise<ComplianceScore> {
  const currentYear = now.getFullYear();

  const [licenses, certs, ahip, onboardingRun] = await Promise.all([
    db.select().from(stateLicensesTable).where(eq(stateLicensesTable.agentId, agentId)),
    db.select().from(carrierCertificationsTable).where(eq(carrierCertificationsTable.agentId, agentId)),
    db
      .select()
      .from(ahipRecordsTable)
      .where(and(eq(ahipRecordsTable.agentId, agentId), eq(ahipRecordsTable.certificationYear, currentYear)))
      .limit(1),
    db
      .select({ id: checklistRunsTable.id })
      .from(checklistRunsTable)
      .where(
        and(
          eq(checklistRunsTable.agentId, agentId),
          eq(checklistRunsTable.orgId, orgId),
          sql`${checklistRunsTable.type} = 'onboarding'`,
        ),
      )
      .orderBy(sql`${checklistRunsTable.startedAt} desc`)
      .limit(1),
  ]);

  let onboardingTaskScore = 0;
  let onboardingCompletedItems = 0;
  let onboardingTotalItems = 0;

  if (onboardingRun[0]) {
    const items = await db
      .select({ status: checklistItemsTable.status })
      .from(checklistItemsTable)
      .where(eq(checklistItemsTable.runId, onboardingRun[0].id));

    onboardingTotalItems = items.length;
    onboardingCompletedItems = items.filter(
      (i) => i.status === "completed" || i.status === "skipped",
    ).length;
    onboardingTaskScore =
      onboardingTotalItems > 0 ? (onboardingCompletedItems / onboardingTotalItems) * 100 : 0;
  }

  const activeLicenses = licenses.filter((l) => l.status === "active").length;
  const activeCerts = certs.filter((c) => c.status === "passed").length;
  const ahipCompleted = ahip[0]?.status === "passed";

  const licenseScore = licenses.length > 0 ? (activeLicenses / licenses.length) * 100 : 0;
  const certScore = certs.length > 0 ? (activeCerts / certs.length) * 100 : 0;
  const ahipScore = ahipCompleted ? 100 : 0;

  const totalScore =
    licenseScore * 0.4 + certScore * 0.3 + ahipScore * 0.2 + onboardingTaskScore * 0.1;

  return {
    agentId,
    totalScore: Math.round(totalScore * 10) / 10,
    licenseScore: Math.round(licenseScore * 10) / 10,
    certificationScore: Math.round(certScore * 10) / 10,
    ahipScore,
    onboardingScore: Math.round(onboardingTaskScore * 10) / 10,
    activeLicenses,
    totalLicenses: licenses.length,
    activeCertifications: activeCerts,
    totalCertifications: certs.length,
    ahipCompleted,
    onboardingComplete: onboardingTotalItems > 0 && onboardingCompletedItems >= onboardingTotalItems,
    onboardingCompletedItems,
    onboardingTotalItems,
  };
}
