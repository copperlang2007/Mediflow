/**
 * Shared types + the `resolveField` helper for the per-carrier template
 * registry.
 *
 * Why a separate types module? Every carrier config file imports the same
 * `CarrierTemplateConfig` shape; collocating it with `index.ts` would force
 * a circular import the moment a carrier file wanted to reference a sibling
 * carrier's helper. Keeping the types out of `index.ts` keeps the import
 * graph a DAG.
 */
import type {
  Agent,
  AgentContractingProfile,
  CarrierContractingRequest,
} from "@workspace/db";
import type { PdfFieldValue } from "../pdfFiller";

// `types.ts` deliberately does NOT import `@workspace/db`'s runtime
// surface — it pulls types only. The DB module's index.ts throws on
// import when `DATABASE_URL` is unset, and config files in this directory
// must be importable from unit tests that don't boot a database (the
// per-carrier `*.ts` files themselves transitively import from this
// module via their `CarrierTemplateConfig` annotation).
//
// SSN handling: the caller is responsible for decrypting and passing
// the plaintext via `ResolveFieldContext.ssnPlaintext`. The routes layer
// already imports `decryptSsn` for the masked-response path, so this
// adds no new decrypt site — it just centralizes who knows the secret.

/**
 * Every field a carrier template can ask for, addressed by a tiny dot-path
 * grammar. Why a string grammar instead of a typed function? The configs
 * live in plain `.ts` files that the design-partner-facing scaffolding doc
 * can describe in English — "set `agent.fullName` on this field" is far
 * less intimidating than "import these getters and call them".
 *
 * Add a new source string here when a carrier needs a new derived field;
 * the `resolveField` switch below must grow in lockstep.
 */
export type FieldSource =
  | "agent.fullName"
  | "agent.firstName"
  | "agent.lastName"
  | "agent.email"
  | "profile.npn"
  | "profile.ssn"
  | "profile.ssnLast4"
  | "profile.dob"
  | "profile.phone"
  | "profile.email"
  | "profile.entityType"
  | "profile.businessName"
  | "profile.eAndOCarrier"
  | "profile.eAndOPolicyNumber"
  | "profile.eAndOExpiresOn"
  | "profile.homeAddressLine1"
  | "profile.homeAddressLine2"
  | "profile.homeCity"
  | "profile.homeState"
  | "profile.homeZip"
  | "profile.homeAddressFull"
  | "profile.mailingAddressFull"
  | "request.states"
  | "request.statesCount"
  | "request.id"
  | "constant.true"
  | "constant.false";

export interface CarrierTemplateFieldBinding {
  /** AcroForm field name on the PDF template. */
  name: string;
  /** Where to pull the value from — see `FieldSource` for the grammar. */
  source: FieldSource;
  /**
   * Optional literal override. When set, the literal wins over `source` —
   * useful for "always check this consent box" rows.
   */
  literal?: PdfFieldValue;
}

export interface CarrierTemplateConfig {
  /**
   * Path to the template PDF, RELATIVE to the carrierTemplates/fixtures
   * directory. When the file doesn't exist yet (stub mode), the registry
   * synthesises a stub on the fly — this is the swap-in target for the
   * real INSUREitALL PDFs.
   */
  templatePath: string;
  /** Human-readable carrier name; used in stub headers + the documents row. */
  name: string;
  /**
   * Template version. Bump this whenever the field map or the underlying
   * PDF changes — admins use it to spot agents who signed against a stale
   * version. `stub-v0` is the convention for the initial scaffolding stubs.
   */
  version: string;
  /** Field bindings the registry resolves before calling `fillTemplate`. */
  fields: CarrierTemplateFieldBinding[];
  /**
   * Marker string the e-sign provider searches for to place the visible
   * signature. Defaults to `/SIG/`; carriers can override if their template
   * needs a different anchor.
   */
  signatureAnchor: string;
}

/**
 * Everything `resolveField` can see. Profile + request can be null when the
 * caller hasn't loaded them — the resolver returns `null` for those fields
 * instead of throwing, which lets the route generate paperwork even when
 * the agent hasn't filled in every optional field yet.
 *
 * `ssnPlaintext`: the caller is responsible for decrypting the SSN before
 * calling — see comment at top of file. Pass `null` when no SSN is on
 * the profile or the caller wants to leave the SSN-derived fields blank.
 */
export interface ResolveFieldContext {
  agent: Pick<Agent, "firstName" | "lastName" | "email"> & {
    /** Pre-formatted full name; resolver falls back to `firstName lastName` if absent. */
    fullName?: string | null;
  };
  profile: AgentContractingProfile | null;
  request: Pick<CarrierContractingRequest, "id" | "states"> | null;
  /** Decrypted SSN plaintext (9 digits, no dashes). Caller decrypts. */
  ssnPlaintext?: string | null;
}

/**
 * Resolve a `FieldSource` string against the given context. Returns:
 *   - `string` for text fields,
 *   - `boolean` for checkboxes,
 *   - `null` when the field is unavailable (caller should skip).
 *
 * Why no `throw` on missing data? `fillTemplate` already skips
 * `null`/`undefined` values, so a missing optional address line just leaves
 * the corresponding AcroForm field blank — which is the carrier-desk
 * expected behavior. Throwing would block paperwork generation for an
 * agent who simply hasn't filled in every optional field.
 */
export function resolveField(
  source: FieldSource,
  ctx: ResolveFieldContext,
): PdfFieldValue {
  const { agent, profile, request } = ctx;

  switch (source) {
    case "agent.fullName": {
      if (agent.fullName != null && agent.fullName.trim().length > 0) {
        return agent.fullName;
      }
      const composed = `${agent.firstName ?? ""} ${agent.lastName ?? ""}`.trim();
      return composed.length > 0 ? composed : null;
    }
    case "agent.firstName":
      return agent.firstName ?? null;
    case "agent.lastName":
      return agent.lastName ?? null;
    case "agent.email":
      return agent.email ?? null;

    case "profile.npn":
      // NPN is on the agent row in the live schema, but we accept it via
      // the profile context too (callers that already have the agent can
      // stuff it into `profile` as a convenience). For now it isn't a
      // column on the profile table; resolvers return null and the field
      // is left blank on the stub PDF.
      return null;

    case "profile.ssn":
      return ctx.ssnPlaintext ?? null;

    case "profile.ssnLast4": {
      const plain = ctx.ssnPlaintext;
      if (!plain || plain.length < 4) return null;
      return plain.slice(-4);
    }

    case "profile.dob":
      return profile?.dob ?? null;
    case "profile.phone":
      return profile?.phone ?? null;
    case "profile.email":
      return profile?.email ?? null;
    case "profile.entityType":
      return profile?.entityType ?? null;
    case "profile.businessName":
      return profile?.businessName ?? null;
    case "profile.eAndOCarrier":
      return profile?.eAndOCarrier ?? null;
    case "profile.eAndOPolicyNumber":
      return profile?.eAndOPolicyNumber ?? null;
    case "profile.eAndOExpiresOn":
      return profile?.eAndOExpiresOn ?? null;
    case "profile.homeAddressLine1":
      return profile?.homeAddressLine1 ?? null;
    case "profile.homeAddressLine2":
      return profile?.homeAddressLine2 ?? null;
    case "profile.homeCity":
      return profile?.homeCity ?? null;
    case "profile.homeState":
      return profile?.homeState ?? null;
    case "profile.homeZip":
      return profile?.homeZip ?? null;

    case "profile.homeAddressFull":
      return composeAddress(
        profile?.homeAddressLine1,
        profile?.homeAddressLine2,
        profile?.homeCity,
        profile?.homeState,
        profile?.homeZip,
      );

    case "profile.mailingAddressFull": {
      // If `mailingSameAsHome` is set, mirror the home address — saves the
      // template from having to declare two parallel field bindings.
      if (profile?.mailingSameAsHome) {
        return composeAddress(
          profile?.homeAddressLine1,
          profile?.homeAddressLine2,
          profile?.homeCity,
          profile?.homeState,
          profile?.homeZip,
        );
      }
      return composeAddress(
        profile?.mailingAddressLine1,
        profile?.mailingAddressLine2,
        profile?.mailingCity,
        profile?.mailingState,
        profile?.mailingZip,
      );
    }

    case "request.states":
      if (!request?.states || request.states.length === 0) return null;
      return request.states.join(", ");
    case "request.statesCount":
      if (!request?.states) return null;
      return String(request.states.length);
    case "request.id":
      return request?.id ?? null;

    case "constant.true":
      return true;
    case "constant.false":
      return false;

    default: {
      // Exhaustive guard — if we add a `FieldSource` and forget to wire it
      // here the type system + this assignment will surface the gap.
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function composeAddress(
  line1?: string | null,
  line2?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null,
): string | null {
  const parts: string[] = [];
  if (line1) parts.push(line1);
  if (line2) parts.push(line2);
  const csz = [city, state, zip].filter((v): v is string => Boolean(v)).join(" ");
  if (csz) parts.push(csz);
  return parts.length > 0 ? parts.join(", ") : null;
}
