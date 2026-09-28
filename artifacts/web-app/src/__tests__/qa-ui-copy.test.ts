import { describe, it, expect } from "vitest";
import { formatPhone } from "@/lib/phone";
import { plainControlNote } from "@/pages/admin-compliance";

describe("formatPhone (display only)", () => {
  it("formats US E.164 and 10-digit numbers", () => {
    expect(formatPhone("+15555550029")).toBe("(555) 555-0029");
    expect(formatPhone("5555550029")).toBe("(555) 555-0029");
    expect(formatPhone("1-555-555-0029")).toBe("(555) 555-0029");
  });

  it("leaves non-US and unparseable values as stored", () => {
    expect(formatPhone("+442079460000")).toBe("+442079460000");
    expect(formatPhone("+4420794600")).toBe("+4420794600");
    expect(formatPhone("ext 12")).toBe("ext 12");
    expect(formatPhone(null)).toBe("");
  });
});

describe("plainControlNote", () => {
  it("never shows code names to users", () => {
    const note = plainControlNote("phi_masking_active", "maskContact present in routes/contacts.ts (PHI_MASK_VERSION=1)");
    expect(note).not.toMatch(/maskContact|PHI_MASK_VERSION|routes\//);
  });

  it("rewrites table and query wording in plain language", () => {
    expect(plainControlNote("object_storage_acl_enforced", "object_storage_policies table not provisioned yet — provider-level ACL still applies"))
      .not.toMatch(/object_storage_policies|ACL/);
    expect(plainControlNote("data_retention_policy_set", "1 retention policy row(s) configured")).toBe("1 record-keeping rule set.");
    expect(plainControlNote("x", "Audit log query failed: boom")).not.toMatch(/boom|query/);
  });
});
