/** Side-by-side comparison of up to 4 plans the agent ticked "Compare" on. */
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { PlanCardData, PlanSummary } from "@/lib/portalDialer/api";
import { extraChips, money, moopOf } from "./planCardModel";

export const MAX_COMPARE = 4;

type Cell = { text: ReactNode; best?: boolean };

const yesNo = (v: boolean) => (v ? "Included" : "Not listed");

function rows(plans: PlanSummary[]): { label: string; cells: Cell[] }[] {
  const cards = plans.map((p) => p.card);
  const num = (vals: (number | null)[], fmt: (n: number) => string): Cell[] => {
    const known = vals.filter((v): v is number => v != null);
    const min = known.length >= 2 ? Math.min(...known) : null;
    return vals.map((v) => ({ text: v == null ? "See details" : fmt(v), best: v != null && min != null && v === min && known.filter((k) => k === min).length === 1 }));
  };
  const txt = (get: (c: PlanCardData) => string | null | undefined): Cell[] =>
    cards.map((c) => ({ text: (c && get(c)) || "See details" }));
  return [
    { label: "Monthly premium (health plan)", cells: num(cards.map((c) => c?.premium ?? null), money) },
    { label: "Part B premium paid back", cells: cards.map((c) => ({ text: c?.partBGiveback != null ? `${money(c.partBGiveback)}/mo` : "None listed" })) },
    { label: "Out-of-pocket max", cells: num(cards.map((c) => moopOf(c)), money) },
    { label: "Medical deductible", cells: cards.map((c) => ({ text: c?.deductible != null ? money(c.deductible) : "See details" })) },
    { label: "Primary care visit", cells: txt((c) => c.costs.pcp?.label) },
    { label: "Specialist visit", cells: txt((c) => c.costs.specialist?.label) },
    { label: "Emergency room", cells: txt((c) => c.costs.er?.label) },
    { label: "Urgent care", cells: txt((c) => c.costs.urgentCare?.label) },
    { label: "Hospital stay", cells: txt((c) => c.costs.hospital) },
    {
      label: "Dental",
      cells: cards.map((c) => ({
        text: !c ? "See details" : c.extras.dental.preventive || c.extras.dental.comprehensive ? (c.extras.dental.maximum ?? "Included") : "Not listed",
      })),
    },
    { label: "Vision", cells: cards.map((c) => ({ text: !c ? "See details" : c.extras.vision.exam || c.extras.vision.eyewear ? (c.extras.vision.allowance ? `Included · eyewear ${c.extras.vision.allowance}` : "Included") : "Not listed" })) },
    { label: "Hearing", cells: cards.map((c) => ({ text: !c ? "See details" : c.extras.hearing.exam || c.extras.hearing.aids ? (c.extras.hearing.allowance ? `Included · aids ${c.extras.hearing.allowance}` : "Included") : "Not listed" })) },
    { label: "OTC allowance", cells: cards.map((c) => ({ text: !c ? "See details" : c.extras.otc.offered ? (c.extras.otc.allowance ?? "Included") : "Not listed" })) },
    { label: "Fitness", cells: cards.map((c) => ({ text: c ? yesNo(c.extras.fitness) : "See details" })) },
    { label: "Meals", cells: cards.map((c) => ({ text: c ? yesNo(c.extras.meals) : "See details" })) },
    { label: "Rides", cells: cards.map((c) => ({ text: c ? yesNo(c.extras.transportation) : "See details" })) },
    {
      label: "Prescription drugs",
      cells: cards.map((c) => ({
        text: !c || c.drugs.covered == null ? "See details" : c.drugs.covered ? `Included${c.drugs.deductible ? ` · deductible ${c.drugs.deductible}` : ""}` : "Not included",
      })),
    },
  ];
}

export function PlanCompare({ plans, open, onOpenChange }: { plans: PlanSummary[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const table = rows(plans);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Compare plans</DialogTitle>
          <DialogDescription>
            Health plan premiums only — Part D drug premiums are not in this data. The lowest health plan premium and out-of-pocket max are highlighted.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto px-5 pb-5">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 top-0 z-20 w-40 bg-card p-2 text-left font-medium text-muted-foreground">
                  <span className="sr-only">Benefit</span>
                </th>
                {plans.map((p) => (
                  <th key={p.bidId} scope="col" className="sticky top-0 z-10 min-w-40 bg-card p-2 text-left align-bottom">
                    <span className="block truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {p.orgMarketingName ?? p.orgName ?? "Carrier"}
                    </span>
                    <span className="line-clamp-2 font-semibold">{p.planName ?? p.bidId}</span>
                    {p.card && extraChips(p.card).length === 0 && <span className="sr-only">No extras listed</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.label}>
                  <th scope="row" className="sticky left-0 z-10 border-t border-border/60 bg-card p-2 text-left font-medium text-muted-foreground">
                    {r.label}
                  </th>
                  {r.cells.map((c, i) => (
                    <td key={plans[i]!.bidId} className={cn("border-t border-border/60 p-2 align-top break-words", c.best && "font-semibold text-success")}>
                      {c.text}
                      {c.best && <span className="sr-only"> (best)</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
