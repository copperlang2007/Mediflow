import type { CarrierTemplateConfig } from "./types";

export const config: CarrierTemplateConfig = {
  templatePath: "wellcare-stub.pdf",
  name: "Wellcare",
  version: "stub-v0",
  fields: [
    { name: "agent_full_name", source: "agent.fullName" },
    { name: "agent_email", source: "agent.email" },
    { name: "agent_npn", source: "profile.npn" },
    { name: "agent_ssn_last_4", source: "profile.ssnLast4" },
    { name: "agent_dob", source: "profile.dob" },
    { name: "agent_phone", source: "profile.phone" },
    { name: "agent_address_full", source: "profile.homeAddressFull" },
    { name: "states_contracting", source: "request.states" },
    { name: "entity_type", source: "profile.entityType" },
    { name: "e_and_o_carrier", source: "profile.eAndOCarrier" },
    { name: "e_and_o_expires_on", source: "profile.eAndOExpiresOn" },
    { name: "consent_electronic_business", source: "constant.true" },
  ],
  signatureAnchor: "/SIG/",
};
