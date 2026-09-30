/**
 * The call_scoring permission entries. Transcripts and quotes are PHI, so the
 * matrix is deliberately narrow: only compliance-audience roles create and
 * review; `agent` may read (routes narrow that to their own calls).
 */
import { describe, expect, it } from "vitest";
import { allowedRoles, can } from "../permissions";

describe("call_scoring permissions", () => {
  it("read: owners, compliance and (self-scoped) agents", () => {
    expect([...allowedRoles("call_scoring", "read")].sort()).toEqual(["agency_admin", "agent", "compliance_manager", "super_admin"]);
  });

  it("create and review: super_admin, agency_admin, compliance_manager only", () => {
    const expected = ["agency_admin", "compliance_manager", "super_admin"];
    expect([...allowedRoles("call_scoring", "create")].sort()).toEqual(expected);
    expect([...allowedRoles("call_scoring", "review")].sort()).toEqual(expected);
  });

  it("agents, support, viewers and developers can never create or review", () => {
    for (const role of ["agent", "agent_support", "viewer", "developer"] as const) {
      expect(can(role, "call_scoring", "create")).toBe(false);
      expect(can(role, "call_scoring", "review")).toBe(false);
    }
    for (const role of ["agent_support", "viewer", "developer"] as const) {
      expect(can(role, "call_scoring", "read")).toBe(false);
    }
  });

  it("nothing else is granted (delete/update/admin default to super_admin only)", () => {
    expect(allowedRoles("call_scoring", "delete")).toEqual(["super_admin"]);
    expect(allowedRoles("call_scoring", "update")).toEqual(["super_admin"]);
  });
});
