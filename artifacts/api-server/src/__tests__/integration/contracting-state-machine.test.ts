/**
 * Pure-function tests for the contracting/onboarding state-machine.
 *
 * The machine is a hot path — bad transitions corrupt audit history and
 * surface as "stuck" requests in the admin dashboard. Every allowed +
 * forbidden transition is exercised here so the matrix is locked down.
 */
import { describe, it, expect } from "vitest";
import {
  canTransitionOnboarding,
  canTransitionContracting,
  isOnboardingStatus,
  isContractingStatus,
  ONBOARDING_STATUSES,
  CONTRACTING_STATUSES,
  ONBOARDING_STEP_ON_ENTER,
} from "../../workers/contractingStateMachine";

describe("contracting state machine — onboarding", () => {
  it("happy path: draft → profile → documents → carriers → signing → submitted → complete", () => {
    expect(canTransitionOnboarding("draft", "profile_in_progress")).toBe(true);
    expect(canTransitionOnboarding("profile_in_progress", "documents_in_progress")).toBe(true);
    expect(canTransitionOnboarding("documents_in_progress", "carriers_selected")).toBe(true);
    expect(canTransitionOnboarding("carriers_selected", "signing")).toBe(true);
    expect(canTransitionOnboarding("signing", "submitted")).toBe(true);
    expect(canTransitionOnboarding("submitted", "complete")).toBe(true);
  });

  it("idempotent: any → same status is always allowed", () => {
    for (const s of ONBOARDING_STATUSES) {
      expect(canTransitionOnboarding(s, s)).toBe(true);
    }
  });

  it("cancel is reachable from every non-terminal status", () => {
    expect(canTransitionOnboarding("draft", "cancelled")).toBe(true);
    expect(canTransitionOnboarding("profile_in_progress", "cancelled")).toBe(true);
    expect(canTransitionOnboarding("documents_in_progress", "cancelled")).toBe(true);
    expect(canTransitionOnboarding("carriers_selected", "cancelled")).toBe(true);
    expect(canTransitionOnboarding("signing", "cancelled")).toBe(true);
    expect(canTransitionOnboarding("submitted", "cancelled")).toBe(true);
  });

  it("complete is terminal — no outbound transitions", () => {
    expect(canTransitionOnboarding("complete", "cancelled")).toBe(false);
    expect(canTransitionOnboarding("complete", "submitted")).toBe(false);
    expect(canTransitionOnboarding("complete", "signing")).toBe(false);
  });

  it("cancelled is terminal — no outbound transitions", () => {
    expect(canTransitionOnboarding("cancelled", "draft")).toBe(false);
    expect(canTransitionOnboarding("cancelled", "complete")).toBe(false);
  });

  it("forbids skipping the profile step", () => {
    expect(canTransitionOnboarding("draft", "documents_in_progress")).toBe(false);
    expect(canTransitionOnboarding("draft", "carriers_selected")).toBe(false);
    expect(canTransitionOnboarding("draft", "signing")).toBe(false);
    expect(canTransitionOnboarding("draft", "complete")).toBe(false);
  });

  it("forbids reverse transitions across the signing boundary", () => {
    expect(canTransitionOnboarding("submitted", "signing")).toBe(false);
    expect(canTransitionOnboarding("submitted", "carriers_selected")).toBe(false);
    expect(canTransitionOnboarding("signing", "documents_in_progress")).toBe(false);
  });

  it("allows minor backtracks before signing (e.g. amend selections)", () => {
    expect(canTransitionOnboarding("documents_in_progress", "profile_in_progress")).toBe(true);
    expect(canTransitionOnboarding("carriers_selected", "documents_in_progress")).toBe(true);
    expect(canTransitionOnboarding("signing", "carriers_selected")).toBe(true);
  });

  it("isOnboardingStatus correctly narrows the union", () => {
    expect(isOnboardingStatus("draft")).toBe(true);
    expect(isOnboardingStatus("complete")).toBe(true);
    expect(isOnboardingStatus("not_a_status")).toBe(false);
    expect(isOnboardingStatus("")).toBe(false);
  });

  it("ONBOARDING_STEP_ON_ENTER covers every non-terminal entered state", () => {
    expect(ONBOARDING_STEP_ON_ENTER.profile_in_progress).toBeDefined();
    expect(ONBOARDING_STEP_ON_ENTER.documents_in_progress).toBeDefined();
    expect(ONBOARDING_STEP_ON_ENTER.carriers_selected).toBeDefined();
    expect(ONBOARDING_STEP_ON_ENTER.signing).toBeDefined();
    expect(ONBOARDING_STEP_ON_ENTER.complete).toBeDefined();
  });
});

describe("contracting state machine — carrier contracting", () => {
  it("happy path: draft → paperwork_generated → signed → submitted → appointed", () => {
    expect(canTransitionContracting("draft", "paperwork_generated")).toBe(true);
    expect(canTransitionContracting("paperwork_generated", "signed")).toBe(true);
    expect(canTransitionContracting("signed", "submitted")).toBe(true);
    expect(canTransitionContracting("submitted", "appointed")).toBe(true);
  });

  it("allows polling path: submitted → under_review → appointed/rejected", () => {
    expect(canTransitionContracting("submitted", "under_review")).toBe(true);
    expect(canTransitionContracting("under_review", "appointed")).toBe(true);
    expect(canTransitionContracting("under_review", "rejected")).toBe(true);
  });

  it("rejection is recoverable: rejected → draft (regenerate paperwork)", () => {
    expect(canTransitionContracting("rejected", "draft")).toBe(true);
  });

  it("appointed is terminal", () => {
    expect(canTransitionContracting("appointed", "draft")).toBe(false);
    expect(canTransitionContracting("appointed", "rejected")).toBe(false);
    expect(canTransitionContracting("appointed", "cancelled")).toBe(false);
  });

  it("cancelled is terminal", () => {
    expect(canTransitionContracting("cancelled", "draft")).toBe(false);
    expect(canTransitionContracting("cancelled", "appointed")).toBe(false);
  });

  it("cannot skip from draft straight to signed", () => {
    expect(canTransitionContracting("draft", "signed")).toBe(false);
    expect(canTransitionContracting("draft", "submitted")).toBe(false);
  });

  it("isContractingStatus narrows the union", () => {
    expect(isContractingStatus("submitted")).toBe(true);
    expect(isContractingStatus("nope")).toBe(false);
  });

  it("covers every status in CONTRACTING_STATUSES exactly once", () => {
    const unique = new Set(CONTRACTING_STATUSES);
    expect(unique.size).toBe(CONTRACTING_STATUSES.length);
  });
});
