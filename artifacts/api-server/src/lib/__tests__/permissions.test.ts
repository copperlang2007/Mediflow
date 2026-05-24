/**
 * Unit tests for the canonical PHI / PII privileged-roles set.
 *
 * The set previously lived (duplicated) in `routes/contacts.ts` AND
 * `routes/onboarding.ts`. Hoisting to `lib/permissions` keeps the two
 * route files in lock-step; this test pins the exact membership so any
 * future expansion is an explicit, code-reviewed change rather than a
 * drift between the two files.
 */
import { describe, it, expect } from "vitest";
import { PHI_PRIVILEGED_ROLES } from "../permissions";

describe("PHI_PRIVILEGED_ROLES", () => {
  it("contains exactly super_admin, agency_admin, compliance_manager", () => {
    expect([...PHI_PRIVILEGED_ROLES].sort()).toEqual(
      ["agency_admin", "compliance_manager", "super_admin"].sort(),
    );
  });

  it("does NOT include agent or agent_support (PHI/PII must remain masked)", () => {
    expect(PHI_PRIVILEGED_ROLES.has("agent")).toBe(false);
    expect(PHI_PRIVILEGED_ROLES.has("agent_support")).toBe(false);
    expect(PHI_PRIVILEGED_ROLES.has("viewer")).toBe(false);
    expect(PHI_PRIVILEGED_ROLES.has("developer")).toBe(false);
  });

  it("has the three privileged roles", () => {
    expect(PHI_PRIVILEGED_ROLES.has("super_admin")).toBe(true);
    expect(PHI_PRIVILEGED_ROLES.has("agency_admin")).toBe(true);
    expect(PHI_PRIVILEGED_ROLES.has("compliance_manager")).toBe(true);
  });

  it("has size 3", () => {
    expect(PHI_PRIVILEGED_ROLES.size).toBe(3);
  });
});
