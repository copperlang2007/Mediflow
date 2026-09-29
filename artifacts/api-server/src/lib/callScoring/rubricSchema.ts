import { z } from "zod";
import type { Rubric } from "./types";

const Pattern = z
  .string()
  .min(1)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, "invalid regular expression");

const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "use lowercase letters, numbers, - and _");

const CriterionSchema = z
  .object({
    id: Id,
    sectionId: Id,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    citation: z.string().max(300).optional(),
    points: z.number().positive().max(1000),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.enum(["required", "prohibited", "judgment"]),
    evaluator: z.enum(["rules", "llm", "hybrid"]),
    speaker: z.enum(["agent", "client", "unknown", "any"]).optional(),
    patterns: z.array(Pattern).max(50).optional(),
    components: z
      .array(z.object({ id: Id, label: z.string().min(1).max(200), patterns: z.array(Pattern).min(1).max(50) }))
      .max(20)
      .optional(),
    minComponents: z.number().int().positive().optional(),
    withinSeconds: z.number().positive().max(7200).optional(),
    guidance: z.string().max(2000).optional(),
    hint: z.string().max(300).optional(),
  })
  .superRefine((c, ctx) => {
    const hasRules = (c.patterns?.length ?? 0) > 0 || (c.components?.length ?? 0) > 0;
    if (c.kind === "judgment" && c.evaluator !== "llm") {
      ctx.addIssue({ code: "custom", message: `${c.id}: judgment criteria must use evaluator "llm"` });
    }
    if (c.kind !== "judgment" && c.evaluator !== "llm" && !hasRules) {
      ctx.addIssue({ code: "custom", message: `${c.id}: rules/hybrid criteria need patterns or components` });
    }
    if (c.minComponents && c.minComponents > (c.components?.length ?? 0)) {
      ctx.addIssue({ code: "custom", message: `${c.id}: minComponents exceeds number of components` });
    }
  });

export const RubricSchema = z
  .object({
    id: Id,
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(40),
    description: z.string().max(2000),
    passThreshold: z.number().min(0).max(100),
    sections: z
      .array(z.object({ id: Id, name: z.string().min(1).max(200), description: z.string().max(1000).optional() }))
      .min(1),
    criteria: z.array(CriterionSchema).min(1).max(100),
  })
  .superRefine((r, ctx) => {
    const sections = new Set(r.sections.map((s) => s.id));
    const ids = new Set<string>();
    for (const c of r.criteria) {
      if (!sections.has(c.sectionId)) {
        ctx.addIssue({ code: "custom", message: `${c.id}: unknown sectionId "${c.sectionId}"` });
      }
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate criterion id "${c.id}"` });
      ids.add(c.id);
    }
  });

export function parseRubric(input: unknown): Rubric {
  return RubricSchema.parse(input) as Rubric;
}
