/**
 * Fallback carrier template — used when a carrier in the seed list (or one
 * an admin added manually) has no dedicated config file. The Day-3 dummy
 * template effectively becomes this file's stub.
 */
import type { CarrierTemplateConfig } from "./types";

export const config: CarrierTemplateConfig = {
  templatePath: "default-stub.pdf",
  name: "Default Carrier",
  version: "stub-v0",
  fields: [
    { name: "agent_full_name", source: "agent.fullName" },
    { name: "agent_email", source: "agent.email" },
    { name: "agent_phone", source: "profile.phone" },
    { name: "agent_dob", source: "profile.dob" },
    { name: "agent_ssn_last_4", source: "profile.ssnLast4" },
    { name: "agent_address_full", source: "profile.homeAddressFull" },
    { name: "states_contracting", source: "request.states" },
    { name: "consent", source: "constant.true" },
  ],
  signatureAnchor: "/SIG/",
};
