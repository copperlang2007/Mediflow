/**
 * One plan, laid out so an agent can read it in a few seconds: carrier and plan
 * name, the monthly premium, the numbers that decide the real cost (out-of-pocket
 * max, doctor / ER / hospital costs) and the extras that are included.
 *
 * Everything shown is decoded from the CMS Plan Benefit Package files. A value
 * the data does not state reads "See details", never a guess. The premium is the
 * health plan premium only: the CMS file has no Part D (drug) premium.
 */
import { useId, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusPill } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { PlanSummary } from "@/lib/portalDialer/api";
import { extraChips, money, moopOf, type BestFlags } from "./planCardModel";

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right break-words", strong ? "font-semibold" : "font-medium")}>{children}</dd>
    </div>
  );
}

const Unknown = () => <span className="text-xs font-normal text-muted-foreground">See details</span>;

export interface PlanCardProps {
  plan: PlanSummary;
  flags?: BestFlags;
  compareSelected: boolean;
  compareDisabled: boolean;
  onToggleCompare: (bidId: string) => void;
  open: boolean;
  onToggleOpen: (bidId: string) => void;
  /** The full CMS field list, rendered when the card is expanded. */
  details?: ReactNode;
}

export function PlanCard({ plan, flags, compareSelected, compareDisabled, onToggleCompare, open, onToggleOpen, details }: PlanCardProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const card = plan.card;
  const carrier = plan.orgMarketingName ?? plan.orgName ?? "Carrier not listed";
  const moop = moopOf(card);
  const chips = card ? extraChips(card) : [];
  const site = plan.orgWebsite ? (/^https?:\/\//i.test(plan.orgWebsite) ? plan.orgWebsite : `https://${plan.orgWebsite}`) : null;

  return (
    <article
      aria-labelledby={titleId}
      data-testid="plan-card"
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md",
        compareSelected ? "border-primary ring-1 ring-primary/40" : "border-border",
      )}
    >
      <header className="space-y-2 bg-gradient-to-b from-primary/5 to-transparent px-4 pt-4 pb-3">
        <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{carrier}</p>
        <h3 id={titleId} className="line-clamp-2 text-base font-semibold leading-snug">
          {plan.planName ?? plan.bidId}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {plan.planTypeLabel && <StatusPill tone="navy">{plan.planTypeLabel}</StatusPill>}
          {plan.isSnp && <StatusPill tone="info">SNP{plan.snpType ? `: ${plan.snpType}` : ""}</StatusPill>}
          {plan.partial && <StatusPill tone="warning">Partial county</StatusPill>}
        </div>
      </header>

      {!card ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Benefit details for this plan are not loaded. Open the full details below.</p>
      ) : (
        <div className="space-y-3 px-4 pb-4">
          <div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold tracking-tight">{card.premium != null ? money(card.premium) : "—"}</span>
              <span className="text-sm text-muted-foreground">/ month</span>
              {flags?.lowestPremium && <StatusPill tone="success" className="ml-auto self-center">Lowest health plan premium here</StatusPill>}
            </p>
            <p className="text-xs text-muted-foreground">{card.premium != null ? "Health plan premium" : "Premium not listed"}</p>
            {card.partBGiveback != null && (
              <p className="mt-1 text-sm font-medium text-success">Pays back {money(card.partBGiveback)}/mo of your Part B premium</p>
            )}
            {card.drugs.covered && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
                Drug plan (Part D) premium is not included in this number.
              </p>
            )}
          </div>

          {plan.isSnp && plan.snpType === "Dual-Eligible" && (
            <p className="rounded-lg bg-info/10 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              Costs shown are the plan's Medicare cost-sharing. For dual-eligible members, Medicaid may cover some or all of it.
            </p>
          )}

          <dl className="divide-y divide-border/60 border-y border-border/60">
            <Row label="Out-of-pocket max" strong>
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                {flags?.lowestMoop && <StatusPill tone="success">Lowest here</StatusPill>}
                {moop != null ? money(moop) : <Unknown />}
              </span>
            </Row>
            {card.moopCombined != null && card.moopCombined !== moop && (
              <Row label="In + out of network max">{money(card.moopCombined)}</Row>
            )}
            {card.deductible != null && <Row label="Medical deductible">{money(card.deductible)}</Row>}
            <Row label="Primary care visit">{card.costs.pcp?.label ?? <Unknown />}</Row>
            <Row label="Specialist visit">{card.costs.specialist?.label ?? <Unknown />}</Row>
            <Row label="Emergency room">{card.costs.er?.label ?? <Unknown />}</Row>
            <Row label="Urgent care">{card.costs.urgentCare?.label ?? <Unknown />}</Row>
            <Row label="Hospital stay">{card.costs.hospital ?? <Unknown />}</Row>
          </dl>

          {chips.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Included extras</p>
              <ul className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <li key={c.key} className="rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs leading-tight">
                    <span className="font-medium">{c.label}</span>
                    {c.detail && <span className="block text-[11px] text-muted-foreground">{c.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {card.drugs.covered !== null && (
            <p className="text-sm">
              <span className="font-semibold">Prescription drugs: </span>
              {card.drugs.covered ? (
                <>
                  Included
                  {card.drugs.deductible && (
                    <span className="text-muted-foreground">
                      {" · "}
                      {card.drugs.deductible.startsWith("$") ? `deductible ${card.drugs.deductible}` : card.drugs.deductible}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Not included</span>
              )}
            </p>
          )}
        </div>
      )}

      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-4 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={compareSelected}
            disabled={compareDisabled && !compareSelected}
            onCheckedChange={() => onToggleCompare(plan.bidId)}
            aria-label={`Compare ${plan.planName ?? plan.bidId}`}
          />
          Compare
        </label>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={() => onToggleOpen(plan.bidId)}
        >
          Full details
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </footer>

      {open && (
        <div className="space-y-3 border-t border-border/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {plan.contractId}-{plan.planId}-{plan.segmentId}
            {site && (
              <>
                {" · "}
                <a className="underline" href={site} target="_blank" rel="noopener noreferrer">Carrier website</a>
              </>
            )}
          </p>
          {details}
        </div>
      )}
    </article>
  );
}
