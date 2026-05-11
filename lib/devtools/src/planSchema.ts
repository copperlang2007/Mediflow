/**
 * Zod schemas for the AI Feature Builder.
 *
 * The "plan" is the structured-output the model produces when asked to
 * describe a feature change. It enumerates every file that will be
 * touched, along with a one-line preview and reason. The full file
 * contents are NOT part of the plan — those arrive in a second pass via
 * the `/apply` endpoint, which lets a human review the plan before any
 * code is actually generated.
 */
import { z } from "zod";

export const FeaturePlanFile = z.object({
  path: z.string(),
  action: z.enum(["create", "modify"]),
  // Summary or short snippet — explicitly NOT the full file content.
  // Bounded so a malformed plan can't blow up the response payload.
  preview: z.string().max(2000),
  reason: z.string().max(500),
});

export type FeaturePlanFile = z.infer<typeof FeaturePlanFile>;

export const FeaturePlan = z.object({
  summary: z.string().min(10).max(500),
  // Slug must be safe for use as a git branch name fragment. We enforce
  // the lowercase-kebab shape here so we don't have to sanitize on the
  // apply side.
  branchSlug: z.string().regex(/^[a-z0-9-]+$/),
  files: z.array(FeaturePlanFile).max(50),
  migrationsNeeded: z.boolean(),
  rbacChanges: z.boolean(),
  openApiChanges: z.boolean(),
  testsIncluded: z.boolean(),
  risks: z.array(z.string()).max(10),
});

export type FeaturePlan = z.infer<typeof FeaturePlan>;

/**
 * JSON schema representation of the plan, suitable for OpenAI's
 * `response_format: { type: "json_schema", json_schema: {...} }` mode.
 *
 * We hand-write this rather than reaching for `zod-to-json-schema` so
 * the dependency footprint stays small and the on-the-wire shape stays
 * pinned to exactly what the API endpoint cares about.
 */
export const FeaturePlanJsonSchema = {
  name: "FeaturePlan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", minLength: 10, maxLength: 500 },
      branchSlug: { type: "string", pattern: "^[a-z0-9-]+$" },
      files: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            action: { type: "string", enum: ["create", "modify"] },
            preview: { type: "string", maxLength: 2000 },
            reason: { type: "string", maxLength: 500 },
          },
          required: ["path", "action", "preview", "reason"],
        },
      },
      migrationsNeeded: { type: "boolean" },
      rbacChanges: { type: "boolean" },
      openApiChanges: { type: "boolean" },
      testsIncluded: { type: "boolean" },
      risks: {
        type: "array",
        maxItems: 10,
        items: { type: "string" },
      },
    },
    required: [
      "summary",
      "branchSlug",
      "files",
      "migrationsNeeded",
      "rbacChanges",
      "openApiChanges",
      "testsIncluded",
      "risks",
    ],
  },
} as const;
