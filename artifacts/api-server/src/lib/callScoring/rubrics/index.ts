import type { Rubric } from "../types";
import { generalSalesRubric } from "./general";
import { medicareRubric } from "./medicare";

/** Built-in rubrics. They are data: edit the phrase lists and citations, not the engine. */
export const builtInRubrics: Rubric[] = [medicareRubric, generalSalesRubric];

export const DEFAULT_RUBRIC_ID = medicareRubric.id;

export function getRubric(id: string): Rubric | undefined {
  return builtInRubrics.find((r) => r.id === id);
}

export { generalSalesRubric, medicareRubric };
