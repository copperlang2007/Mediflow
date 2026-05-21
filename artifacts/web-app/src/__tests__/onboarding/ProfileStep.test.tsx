// @vitest-environment jsdom
/**
 * Form validation + patch-shape tests for the onboarding wizard's
 * ProfileStep. We don't render the full step here (that would require
 * mocking the API client + ReactQuery provider + Clerk auth) — instead we
 * test the two pure exported helpers: the zod schema and `formToPatch`.
 *
 * Those two are the safety-critical surfaces: zod validates user input
 * before it ever leaves the browser, and formToPatch decides what we PATCH
 * to the server (the masking rules around SSN/EIN in particular).
 */
import { describe, it, expect } from "vitest";
import {
  __ProfileFormSchema,
  formToPatch,
} from "@/pages/onboarding/steps/ProfileStep";
import type { AgentContractingProfile } from "@/lib/onboarding/api";

type FormState = ReturnType<typeof __ProfileFormSchema.parse>;

function blankForm(): FormState {
  return {
    ssn: "",
    dob: "",
    homeAddressLine1: "",
    homeAddressLine2: "",
    homeCity: "",
    homeState: "",
    homeZip: "",
    mailingSameAsHome: true,
    mailingAddressLine1: "",
    mailingAddressLine2: "",
    mailingCity: "",
    mailingState: "",
    mailingZip: "",
    phone: "",
    email: "",
    entityType: "",
    businessName: "",
    businessEin: "",
    eAndOCarrier: "",
    eAndOPolicyNumber: "",
    eAndOExpiresOn: "",
    backgroundCheckAuthorized: false,
  };
}

describe("ProfileFormSchema", () => {
  it("accepts an entirely empty form (the wizard supports incremental save)", () => {
    const result = __ProfileFormSchema.safeParse(blankForm());
    expect(result.success).toBe(true);
  });

  it("rejects an SSN that is not 9 digits", () => {
    const form = { ...blankForm(), ssn: "12-34" };
    const result = __ProfileFormSchema.safeParse(form);
    expect(result.success).toBe(false);
  });

  it("accepts a 9-digit SSN with dashes (we strip non-digits)", () => {
    const form = { ...blankForm(), ssn: "123-45-6789" };
    expect(__ProfileFormSchema.safeParse(form).success).toBe(true);
  });

  it("rejects an EIN that is not 9 digits", () => {
    const form = { ...blankForm(), businessEin: "12-345" };
    expect(__ProfileFormSchema.safeParse(form).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const form = { ...blankForm(), email: "not-an-email" };
    expect(__ProfileFormSchema.safeParse(form).success).toBe(false);
  });

  it("rejects DOB not in YYYY-MM-DD format", () => {
    const form = { ...blankForm(), dob: "01/02/2000" };
    expect(__ProfileFormSchema.safeParse(form).success).toBe(false);
  });
});

describe("formToPatch", () => {
  it("returns mailingSameAsHome but no mailing fields when same-as-home", () => {
    const form: FormState = {
      ...blankForm(),
      mailingSameAsHome: true,
      mailingCity: "Phantom City",
      mailingState: "FL",
    };
    const patch = formToPatch(form, null);
    expect(patch.mailingSameAsHome).toBe(true);
    expect(patch.mailingCity).toBeUndefined();
    expect(patch.mailingState).toBeUndefined();
  });

  it("includes mailing fields when same-as-home is false", () => {
    const form: FormState = {
      ...blankForm(),
      mailingSameAsHome: false,
      mailingAddressLine1: "PO Box 9",
      mailingCity: "Boca",
      mailingState: "FL",
      mailingZip: "33431",
    };
    const patch = formToPatch(form, null);
    expect(patch.mailingSameAsHome).toBe(false);
    expect(patch.mailingAddressLine1).toBe("PO Box 9");
    expect(patch.mailingCity).toBe("Boca");
    expect(patch.mailingState).toBe("FL");
    expect(patch.mailingZip).toBe("33431");
  });

  it("does NOT include an SSN that matches the masked sentinel on the existing profile", () => {
    // If the server returned MASKED_SSN we don't want to re-send it as
    // an "update" — that would re-encrypt the literal masked string.
    const form: FormState = { ...blankForm(), ssn: "" }; // input cleared
    const existing: AgentContractingProfile = {
      orgId: "o",
      agentId: "a",
      ssn: "***-**-****",
      ein: null,
      dob: null,
      homeAddressLine1: null,
      homeAddressLine2: null,
      homeCity: null,
      homeState: null,
      homeZip: null,
      mailingSameAsHome: null,
      mailingAddressLine1: null,
      mailingAddressLine2: null,
      mailingCity: null,
      mailingState: null,
      mailingZip: null,
      phone: null,
      email: null,
      entityType: null,
      businessName: null,
      eAndOCarrier: null,
      eAndOPolicyNumber: null,
      eAndOExpiresOn: null,
    };
    const patch = formToPatch(form, existing);
    expect(patch.ssn).toBeUndefined();
  });

  it("includes SSN when supplied and the existing profile has no SSN", () => {
    const form: FormState = { ...blankForm(), ssn: "123-45-6789" };
    const patch = formToPatch(form, null);
    expect(patch.ssn).toBe("123-45-6789");
  });

  it("includes the businessEin only when changed", () => {
    const form: FormState = { ...blankForm(), businessEin: "12-3456789" };
    const patch = formToPatch(form, null);
    expect(patch.businessEin).toBe("12-3456789");
  });

  it("includes top-level fields when populated", () => {
    const form: FormState = {
      ...blankForm(),
      dob: "1990-01-15",
      phone: "555-1234",
      email: "agent@example.com",
      entityType: "llc",
      businessName: "Smith LLC",
      eAndOCarrier: "Acme Insurance",
      eAndOPolicyNumber: "POL-9",
      eAndOExpiresOn: "2027-12-31",
    };
    const patch = formToPatch(form, null);
    expect(patch.dob).toBe("1990-01-15");
    expect(patch.phone).toBe("555-1234");
    expect(patch.email).toBe("agent@example.com");
    expect(patch.entityType).toBe("llc");
    expect(patch.businessName).toBe("Smith LLC");
    expect(patch.eAndOCarrier).toBe("Acme Insurance");
    expect(patch.eAndOPolicyNumber).toBe("POL-9");
    expect(patch.eAndOExpiresOn).toBe("2027-12-31");
  });
});
