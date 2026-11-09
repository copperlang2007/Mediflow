/**
 * Sorting, filtering and "best value" logic for the plan cards. Pure functions
 * so they are easy to test; the components only render what these return.
 */
import type { PlanCardData, PlanSummary } from "@/lib/portalDialer/api";

export type SortKey = "carrier" | "premium" | "moop" | "giveback" | "name";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "carrier", label: "Carrier A–Z" },
  { key: "premium", label: "Lowest health plan premium" },
  { key: "moop", label: "Lowest out-of-pocket max" },
  { key: "giveback", label: "Highest Part B giveback" },
  { key: "name", label: "Plan name A–Z" },
];

export type FilterKey = "zeroPremium" | "drugs" | "dental" | "vision" | "hearing" | "otc" | "fitness" | "giveback";

export const FILTERS: { key: FilterKey; label: string; test: (c: PlanCardData) => boolean }[] = [
  { key: "zeroPremium", label: "$0 health plan premium", test: (c) => c.premium === 0 },
  { key: "drugs", label: "Drug coverage", test: (c) => c.drugs.covered === true },
  { key: "dental", label: "Dental", test: (c) => c.extras.dental.preventive || c.extras.dental.comprehensive },
  { key: "vision", label: "Vision", test: (c) => c.extras.vision.exam || c.extras.vision.eyewear },
  { key: "hearing", label: "Hearing", test: (c) => c.extras.hearing.exam || c.extras.hearing.aids },
  { key: "otc", label: "OTC allowance", test: (c) => c.extras.otc.offered },
  { key: "fitness", label: "Fitness", test: (c) => c.extras.fitness },
  { key: "giveback", label: "Part B giveback", test: (c) => (c.partBGiveback ?? 0) > 0 },
];

/** The out-of-pocket max a shopper should compare: in-network, else combined. */
export const moopOf = (c: PlanCardData | null): number | null => c?.moopInNetwork ?? c?.moopCombined ?? null;

const carrierOf = (p: PlanSummary) => (p.orgMarketingName ?? p.orgName ?? "").toLowerCase();
const nameOf = (p: PlanSummary) => (p.planName ?? p.bidId).toLowerCase();

/** Plans a filter would exclude because their benefit data is missing are kept out. */
export function filterPlans(plans: PlanSummary[], active: Set<FilterKey>, planType: string): PlanSummary[] {
  const tests = FILTERS.filter((f) => active.has(f.key));
  return plans.filter((p) => {
    if (planType && (p.planTypeLabel ?? "") !== planType) return false;
    return tests.every((t) => p.card != null && t.test(p.card));
  });
}

/** Unknown values always sort last, whatever the direction. */
export function sortPlans(plans: PlanSummary[], key: SortKey): PlanSummary[] {
  const byNumber = (get: (p: PlanSummary) => number | null, dir: 1 | -1) => (a: PlanSummary, b: PlanSummary) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  };
  const tie = (a: PlanSummary, b: PlanSummary) => carrierOf(a).localeCompare(carrierOf(b)) || nameOf(a).localeCompare(nameOf(b));
  const out = [...plans];
  switch (key) {
    case "premium":
      return out.sort((a, b) => byNumber((p) => p.card?.premium ?? null, 1)(a, b) || tie(a, b));
    case "moop":
      return out.sort((a, b) => byNumber((p) => moopOf(p.card), 1)(a, b) || tie(a, b));
    case "giveback":
      return out.sort((a, b) => byNumber((p) => (p.card ? p.card.partBGiveback ?? 0 : null), -1)(a, b) || tie(a, b));
    case "name":
      return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || tie(a, b));
    default:
      return out.sort(tie);
  }
}

export function planTypes(plans: PlanSummary[]): string[] {
  return [...new Set(plans.map((p) => p.planTypeLabel).filter((t): t is string => !!t))].sort();
}

export interface BestFlags {
  lowestPremium: boolean;
  lowestMoop: boolean;
}

/**
 * Badges for the single best plan on a measure. Only given when there are at
 * least 3 plans with that number and the best is strictly better than the rest
 * (a tie is not a "winner").
 */
export function bestFlags(plans: PlanSummary[]): Map<string, BestFlags> {
  const out = new Map<string, BestFlags>();
  const pick = (get: (p: PlanSummary) => number | null): string | null => {
    const vals = plans.map((p) => ({ id: p.bidId, v: get(p) })).filter((x): x is { id: string; v: number } => x.v != null);
    if (vals.length < 3) return null;
    vals.sort((a, b) => a.v - b.v);
    return vals[0]!.v < vals[1]!.v ? vals[0]!.id : null;
  };
  const prem = pick((p) => p.card?.premium ?? null);
  const moop = pick((p) => moopOf(p.card));
  for (const p of plans) out.set(p.bidId, { lowestPremium: p.bidId === prem, lowestMoop: p.bidId === moop });
  return out;
}

export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** "Included extras" shown as short chips on the card. */
export function extraChips(c: PlanCardData): { key: string; label: string; detail?: string }[] {
  const e = c.extras;
  const chips: { key: string; label: string; detail?: string }[] = [];
  if (e.dental.preventive || e.dental.comprehensive) {
    chips.push({
      key: "dental",
      label: e.dental.preventive && e.dental.comprehensive ? "Dental" : e.dental.comprehensive ? "Dental (comprehensive)" : "Dental (preventive)",
      detail: e.dental.maximum ?? undefined,
    });
  }
  if (e.vision.exam || e.vision.eyewear) {
    chips.push({ key: "vision", label: "Vision", detail: e.vision.allowance ? `Eyewear ${e.vision.allowance}` : undefined });
  }
  if (e.hearing.exam || e.hearing.aids) {
    chips.push({ key: "hearing", label: "Hearing", detail: e.hearing.allowance ? `Hearing aids ${e.hearing.allowance}` : undefined });
  }
  if (e.otc.offered) chips.push({ key: "otc", label: "OTC allowance", detail: e.otc.allowance ?? undefined });
  if (e.fitness) chips.push({ key: "fitness", label: "Fitness" });
  if (e.meals) chips.push({ key: "meals", label: "Meals" });
  if (e.transportation) chips.push({ key: "transportation", label: "Rides" });
  return chips;
}
