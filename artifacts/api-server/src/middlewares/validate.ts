import { type RequestHandler } from "express";
import { type ZodTypeAny } from "zod";

export function validate<T extends ZodTypeAny>(
  schema: T,
  source: "body" | "query" | "params" = "body",
): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        details: result.error.issues,
      });
      return;
    }
    next();
  };
}
