import type { CarrierTemplateConfig } from "./types";

export const config: CarrierTemplateConfig = {
  templatePath: "humana-stub.pdf",
  name: "Humana",
  version: "stub-v0",
  fields: [
    { name: "producer_full_name", source: "agent.fullName" },
    { name: "producer_email", source: "agent.email" },
    { name: "producer_npn", source: "profile.npn" },
    { name: "producer_ssn_last_4", source: "profile.ssnLast4" },
    { name: "producer_dob", source: "profile.dob" },
    { name: "producer_phone", source: "profile.phone" },
    { name: "producer_address", source: "profile.homeAddressFull" },
    { name: "states_requested", source: "request.states" },
    { name: "states_count", source: "request.statesCount" },
    { name: "entity_type", source: "profile.entityType" },
    { name: "e_and_o_carrier", source: "profile.eAndOCarrier" },
    { name: "e_and_o_expires", source: "profile.eAndOExpiresOn" },
    { name: "ack_electronic_business", source: "constant.true" },
  ],
  signatureAnchor: "/SIG/",
};
