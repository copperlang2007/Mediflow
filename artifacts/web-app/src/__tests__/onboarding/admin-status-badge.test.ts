/**
 * Pin tests for the STATUS_BADGE map exported from admin-onboarding.tsx.
 *
 * The map drives Tailwind classes on the status pills throughout the
 * admin dashboard. We don't want a stray refactor to silently drop a
 * status's styling, so we assert each of the 8 onboarding statuses has
 * a non-empty class set.
 */
import { describe, it, expect } from "vitest";
import { STATUS_BADGE } from "@/pages/admin-onboarding";
import type { OnboardingStatus } from "@/lib/onboarding/api";

const EXPECTED_STATUSES: OnboardingStatus[] = [
  "draft",
  "profile_in_progress",
  "carriers_selected",
  "signing",
  "submitted",
  "complete",
  "cancelled",
  "rejected",
];

describe("admin-onboarding STATUS_BADGE map", () => {
  it("has an entry for every onboarding status", () => {
    for (const s of EXPECTED_STATUSES) {
      expect(STATUS_BADGE[s]).toBeDefined();
      expect(STATUS_BADGE[s]).toMatch(/\S/);
    }
  });

  it("complete uses a green color family", () => {
    expect(STATUS_BADGE.complete).toMatch(/green/);
  });

  it("cancelled uses a red color family", () => {
    expect(STATUS_BADGE.cancelled).toMatch(/red/);
  });

  it("carriers_selected uses amber (admin attention pending)", () => {
    expect(STATUS_BADGE.carriers_selected).toMatch(/amber/);
  });
});
