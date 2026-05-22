export function summarizeComplianceMatrix(rows) {
  const totals = {
    total: rows.length,
    overdue: 0,
    dueSoon: 0,
    current: 0,
  };

  for (const row of rows) {
    if (row.status === "overdue") totals.overdue += 1;
    else if (row.status === "due_soon") totals.dueSoon += 1;
    else if (row.status === "current") totals.current += 1;
    else throw new Error(`Unknown compliance status: ${row.status}`);
  }

  return totals;
}

export function canAccessComplianceArea(role) {
  return ["super_admin", "agency_admin", "compliance_manager"].includes(role);
}

export function buildRetentionRiskScore({ daysSinceContact, openComplaints, failedPayments }) {
  const contactRisk = Math.min(daysSinceContact / 90, 1) * 40;
  const complaintRisk = Math.min(openComplaints, 3) * 15;
  const paymentRisk = Math.min(failedPayments, 3) * 5;
  return Math.round(Math.min(contactRisk + complaintRisk + paymentRisk, 100));
}
