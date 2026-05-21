/**
 * Unit tests for the onboarding api helpers (wizard state machine,
 * status-label maps, and pure utilities).
 *
 * The mutation hooks are NOT exercised here — they wrap `apiFetch` against
 * the real backend and require an integration harness (covered by the
 * api-server suite). These tests pin the pure UI-side behavior that the
 * wizard relies on.
 */
import { describe, it, expect } from "vitest";
import {
  contractingStatusLabel,
  onboardingStatusLabel,
  wizardStepForRun,
  type AgentOnboardingRun,
  type CarrierContractingRequest,
} from "@/lib/onboarding/api";

function mkRun(overrides: Partial<AgentOnboardingRun>): AgentOnboardingRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    startedByUserId: "u-1",
    status: "draft",
    completedSteps: null,
    startedAt: "2025-01-01T00:00:00Z",
    completedAt: null,
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function mkRequest(
  overrides: Partial<CarrierContractingRequest>,
): CarrierContractingRequest {
  return {
    id: "req-1",
    orgId: "org-1",
    onboardingRunId: "run-1",
    agentId: "agent-1",
    carrierId: "carrier-1",
    states: ["FL"],
    status: "draft",
    paperworkDocumentId: null,
    signatureCompletedAt: null,
    lastStatusChangeAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("onboardingStatusLabel", () => {
  it("returns a human label for every known status", () => {
    expect(onboardingStatusLabel("draft")).toBe("Draft");
    expect(onboardingStatusLabel("profile_in_progress")).toBe("Profile in progress");
    expect(onboardingStatusLabel("carriers_selected")).toBe("Awaiting admin review");
    expect(onboardingStatusLabel("signing")).toBe("Signing paperwork");
    expect(onboardingStatusLabel("submitted")).toBe("Submitted to carriers");
    expect(onboardingStatusLabel("complete")).toBe("Complete");
    expect(onboardingStatusLabel("cancelled")).toBe("Cancelled");
    expect(onboardingStatusLabel("rejected")).toBe("Rejected");
  });

  it("falls back to the raw status for unknown values", () => {
    expect(onboardingStatusLabel("totally_made_up")).toBe("totally_made_up");
  });
});

describe("contractingStatusLabel", () => {
  it("returns a human label for every known contracting status", () => {
    expect(contractingStatusLabel("paperwork_generated")).toBe("Ready to sign");
    expect(contractingStatusLabel("signed")).toBe("Signed");
    expect(contractingStatusLabel("appointed")).toBe("Appointed");
    expect(contractingStatusLabel("rejected")).toBe("Rejected");
  });
});

describe("wizardStepForRun", () => {
  it("returns 'welcome' for a brand-new draft run with no carrier requests", () => {
    expect(wizardStepForRun(mkRun({ status: "draft" }), [])).toBe("welcome");
  });

  it("returns 'carriers' after the profile is in progress with no carrier picks", () => {
    expect(
      wizardStepForRun(mkRun({ status: "profile_in_progress" }), []),
    ).toBe("carriers");
  });

  it("returns 'review' after the profile is in progress and carriers picked", () => {
    expect(
      wizardStepForRun(mkRun({ status: "profile_in_progress" }), [mkRequest({})]),
    ).toBe("review");
  });

  it("returns 'review' when carriers_selected without paperwork yet", () => {
    expect(
      wizardStepForRun(
        mkRun({ status: "carriers_selected" }),
        [mkRequest({ status: "draft" })],
      ),
    ).toBe("review");
  });

  it("returns 'signing' when carriers_selected and paperwork has been generated", () => {
    expect(
      wizardStepForRun(
        mkRun({ status: "carriers_selected" }),
        [mkRequest({ status: "paperwork_generated" })],
      ),
    ).toBe("signing");
  });

  it("returns 'signing' for an actively-signing run", () => {
    expect(
      wizardStepForRun(
        mkRun({ status: "signing" }),
        [mkRequest({ status: "paperwork_generated" })],
      ),
    ).toBe("signing");
  });

  it("returns 'done' for a submitted run", () => {
    expect(
      wizardStepForRun(mkRun({ status: "submitted" }), []),
    ).toBe("done");
  });

  it("returns 'done' for a complete run", () => {
    expect(
      wizardStepForRun(mkRun({ status: "complete" }), []),
    ).toBe("done");
  });

  it("ignores cancelled carrier requests when deciding the signing step", () => {
    // Only a cancelled request → fallback to 'review' on carriers_selected.
    expect(
      wizardStepForRun(
        mkRun({ status: "carriers_selected" }),
        [mkRequest({ status: "cancelled" })],
      ),
      // Note: the function currently uses ".some(r => r.status !== 'draft' && r.status !== 'cancelled')"
      // so a sole cancelled request shouldn't trigger 'signing'.
    ).toBe("review");
  });
});
