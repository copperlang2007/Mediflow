import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRetentionRiskScore,
  canAccessComplianceArea,
  summarizeComplianceMatrix,
} from "../quality/compliance-matrix.mjs";

describe("summarizeComplianceMatrix", () => {
  it("counts current, due-soon, and overdue compliance rows", () => {
    const result = summarizeComplianceMatrix([
      { status: "current" },
      { status: "due_soon" },
      { status: "overdue" },
      { status: "overdue" },
    ]);

    assert.deepEqual(result, {
      total: 4,
      overdue: 2,
      dueSoon: 1,
      current: 1,
    });
  });
});

describe("canAccessComplianceArea", () => {
  it("limits compliance access to privileged roles", () => {
    assert.equal(canAccessComplianceArea("compliance_manager"), true);
    assert.equal(canAccessComplianceArea("agent"), false);
  });
});

describe("buildRetentionRiskScore", () => {
  it("raises retention risk for stale contact and complaints", () => {
    const score = buildRetentionRiskScore({
      daysSinceContact: 90,
      openComplaints: 2,
      failedPayments: 1,
    });

    assert.equal(score, 75);
  });
});
