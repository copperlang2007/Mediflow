import type { CarrierTemplateConfig } from "./types";

export const config: CarrierTemplateConfig = {
  templatePath: "unitedhealth-stub.pdf",
  name: "UnitedHealth/AARP",
  version: "stub-v0",
  fields: [
    { name: "agent_full_name", source: "agent.fullName" },
    { name: "agent_email", source: "agent.email" },
    { name: "agent_npn", source: "profile.npn" },
    { name: "agent_ssn_last_4", source: "profile.ssnLast4" },
    { name: "agent_dob", source: "profile.dob" },
    { name: "agent_phone", source: "profile.phone" },
    { name: "agent_home_address", source: "profile.homeAddressFull" },
    { name: "agent_mailing_address", source: "profile.mailingAddressFull" },
    { name: "states_contracting", source: "request.states" },
    { name: "entity_type", source: "profile.entityType" },
    { name: "business_name", source: "profile.businessName" },
    { name: "e_and_o_carrier", source: "profile.eAndOCarrier" },
    { name: "e_and_o_policy_number", source: "profile.eAndOPolicyNumber" },
    { name: "e_and_o_expires_on", source: "profile.eAndOExpiresOn" },
    { name: "consent_electronic_business", source: "constant.true" },
  ],
  signatureAnchor: "/SIG/",
};
