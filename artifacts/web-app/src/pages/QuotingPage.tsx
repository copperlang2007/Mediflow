/**
 * Quoting Engine — page shell.
 *
 * Mediflow has no plan, premium or formulary data yet, so this page never
 * shows a plan card, premium or star rating. It collects the quote inputs
 * (ZIP, plan type, drugs, doctors), explains exactly what will power the
 * comparison once connected, and uses real data where it exists:
 *   - your carriers, from the `carriers` table;
 *   - doctor lookup against the public CMS NPPES NPI Registry through the
 *     server-side proxy GET /quoting/providers (validated, rate limited).
 */
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import {
  Building2, Database, FileSpreadsheet, Loader2, MapPin, Pill, Plus, Search, Stethoscope, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { ComingSoonNote, NoAccess, SoonBadge } from "@/components/portal-dialer";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import { cn } from "@/lib/utils";
import {
  CONTACT_READ_ROLES,
  formatPhone,
  searchProviders,
  useCarriers,
  type ProviderResult,
} from "@/lib/portalDialer/api";

const PLAN_TYPES = [
  { k: "MA", label: "Medicare Advantage" },
  { k: "PDP", label: "Part D" },
  { k: "SUPP", label: "Medigap" },
] as const;

type Tab = "plans" | "formulary" | "providers";

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium">
      {children}
      <button type="button" onClick={onRemove} aria-label="Remove" className="rounded-full p-0.5 text-muted-foreground hover:text-foreground">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function CarriersCard() {
  const { data, isLoading, isError } = useCarriers();
  const carriers = (data ?? []).filter((c) => c.isActive);
  return (
    <SectionCard title="Your carriers" icon={Building2} description="Quotes will be limited to carriers your agency works with" action={{ label: "Manage", href: "/admin-carriers" }}>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">Your role can't see the carrier list.</p>
      ) : carriers.length === 0 ? (
        <EmptyState compact icon={Building2} title="No carriers added yet" description="Add the carriers you're appointed with so quotes only include plans you can sell." />
      ) : (
        <div className="flex flex-wrap gap-2">
          {carriers.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm">
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              {c.name}
              {c.cmsContractNumber && <span className="text-xs text-muted-foreground">{c.cmsContractNumber}</span>}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ProviderSearch({ onAdd, added }: { onAdd: (p: ProviderResult) => void; added: Set<string> }) {
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ProviderResult[] | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lastName.trim().length < 2) {
      setError("Enter at least two letters of the doctor's last name.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await searchProviders({ lastName, firstName, state, zip });
      setResults(r.data);
    } catch (err) {
      setResults(null);
      setError((err as Error).message || "Doctor lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 md:grid-cols-[1.3fr_1fr_0.5fr_0.7fr_auto] md:items-end">
        <div className="space-y-1.5 col-span-2 md:col-span-1">
          <Label htmlFor="doc-last">Doctor's last name</Label>
          <Input id="doc-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="e.g. Garcia" maxLength={40} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-first">First name</Label>
          <Input id="doc-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Optional" maxLength={40} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-state">State</Label>
          <Input id="doc-state" value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))} placeholder="FL" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-zip">ZIP</Label>
          <Input id="doc-zip" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="Optional" inputMode="numeric" />
        </div>
        <Button type="submit" disabled={loading} className="col-span-2 md:col-span-1">
          {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />} Search
        </Button>
      </form>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {results && (
        results.length === 0 ? (
          <EmptyState compact icon={Stethoscope} title="No doctors found" description="Try fewer details — a last name and state is usually enough." />
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border">
            {results.map((p) => (
              <li key={p.npi} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold">{p.name}{p.credential ? `, ${p.credential}` : ""}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.specialty ?? "Specialty not listed"} · NPI {p.npi}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[p.address, p.city, p.state, p.zip].filter(Boolean).join(", ")}{p.phone ? ` · ${formatPhone(p.phone)}` : ""}
                  </p>
                </div>
                <Button size="sm" variant={added.has(p.npi) ? "secondary" : "outline"} disabled={added.has(p.npi)} onClick={() => onAdd(p)}>
                  {added.has(p.npi) ? "Added" : (<><Plus className="mr-1 h-3.5 w-3.5" /> Add to quote</>)}
                </Button>
              </li>
            ))}
          </ul>
        )
      )}
      <p className="text-[11px] text-muted-foreground">
        Source: CMS NPPES NPI Registry (public provider directory). Whether a doctor is in a plan's network needs carrier network data — <SoonBadge />
      </p>
    </div>
  );
}

export default function QuotingPage() {
  const { role, isLoading } = useIsAdmin(CONTACT_READ_ROLES);
  const allowed = !!role && (CONTACT_READ_ROLES as readonly string[]).includes(role);

  const [zip, setZip] = useState("");
  const [planType, setPlanType] = useState<(typeof PLAN_TYPES)[number]["k"]>("MA");
  const [drugInput, setDrugInput] = useState("");
  const [drugs, setDrugs] = useState<string[]>([]);
  const [doctors, setDoctors] = useState<ProviderResult[]>([]);
  const [tab, setTab] = useState<Tab>("plans");

  if (!isLoading && role && !allowed) return <NoAccess what="the quoting engine" />;

  const addDrug = () => {
    const d = drugInput.trim().replace(/\s+/g, " ").slice(0, 60);
    if (d && !drugs.some((x) => x.toLowerCase() === d.toLowerCase())) setDrugs([...drugs, d]);
    setDrugInput("");
  };
  const zipValid = /^\d{5}$/.test(zip);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader title="Quoting Engine" subtitle="Compare MA, MAPD, Medigap and Part D plans by ZIP code with drug and doctor checks" />

      <div className="rounded-xl border border-warning/30 bg-warning/10 px-5 py-4 text-sm text-amber-900 dark:text-amber-200">
        We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area.
        Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.
      </div>

      <SectionCard contentClassName="py-4 space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="quote-zip">ZIP code</Label>
            <div className="relative w-40">
              <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="quote-zip" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="33101" inputMode="numeric" className="pl-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Plan type</Label>
            <div className="inline-flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Plan type">
              {PLAN_TYPES.map((p) => (
                <button
                  key={p.k}
                  type="button"
                  role="radio"
                  aria-checked={planType === p.k}
                  onClick={() => setPlanType(p.k)}
                  className={cn("rounded-md px-3 py-1.5 text-sm font-medium", planType === p.k ? "bg-card shadow-sm" : "text-muted-foreground")}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="quote-drug">Prescription drugs</Label>
            <div className="flex gap-2">
              <Input
                id="quote-drug"
                value={drugInput}
                onChange={(e) => setDrugInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDrug(); } }}
                placeholder="Type a drug name and press Enter"
                maxLength={60}
              />
              <Button type="button" variant="outline" onClick={addDrug} disabled={!drugInput.trim()} aria-label="Add drug"><Plus className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>
        {(drugs.length > 0 || doctors.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {drugs.map((d) => (
              <Chip key={d} onRemove={() => setDrugs(drugs.filter((x) => x !== d))}><Pill className="h-3 w-3" /> {d}</Chip>
            ))}
            {doctors.map((d) => (
              <Chip key={d.npi} onRemove={() => setDoctors(doctors.filter((x) => x.npi !== d.npi))}><Stethoscope className="h-3 w-3" /> {d.name}</Chip>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Quote inputs stay on this screen only — nothing here is saved to a client record.
        </p>
      </SectionCard>

      <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="Quoting views">
        {([
          { k: "plans", label: "Plan Comparison" },
          { k: "formulary", label: "Formulary Lookup" },
          { k: "providers", label: "Provider Network" },
        ] as const).map((t) => (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={cn("rounded-lg px-4 py-2 text-sm font-medium", tab === t.k ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "plans" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <SectionCard className="lg:col-span-2" title="Plan comparison" icon={Database}>
            <ComingSoonNote tone="setup" icon={Database} title="Plan data isn't connected yet">
              Mediflow doesn't have plan, premium or star-rating data loaded, so no plans are shown — we never show sample prices.
            </ComingSoonNote>
            <div className="mt-5 space-y-3">
              <p className="text-sm font-semibold">What will power this comparison</p>
              {[
                { icon: FileSpreadsheet, t: "CMS plan landscape files", d: "Every MA, MAPD and PDP plan by county: premiums, deductibles, out-of-pocket max and star ratings." },
                { icon: Pill, t: "CMS formulary files", d: "Which drugs each plan covers, at what tier, with prior-auth and quantity limits — to estimate yearly drug cost." },
                { icon: Stethoscope, t: "Provider networks", d: "Whether the client's doctors are in each plan's network. Doctor search already works today (Provider Network tab)." },
                { icon: Building2, t: "Your carriers", d: "Results filtered to the carriers you're appointed with, as the disclaimer above requires." },
              ].map((x) => (
                <div key={x.t} className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><x.icon className="h-4 w-4" /></span>
                  <span className="text-sm"><span className="font-medium">{x.t}</span><span className="block text-muted-foreground">{x.d}</span></span>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button disabled>
                <Search className="mr-1.5 h-4 w-4" /> Compare plans{zipValid ? ` in ${zip}` : ""}
              </Button>
              <SoonBadge />
            </div>
          </SectionCard>
          <CarriersCard />
        </div>
      )}

      {tab === "formulary" && (
        <SectionCard title="Formulary lookup" icon={Pill}>
          <ComingSoonNote tone="setup" icon={Pill} title="Formulary files aren't connected yet">
            Add the client's drugs above. Once CMS formulary data is loaded, this tab shows coverage, tier and restrictions for each drug on each plan.
          </ComingSoonNote>
          <div className="mt-4">
            {drugs.length === 0 ? (
              <EmptyState compact icon={Pill} title="No drugs added" description="Type a drug name in the box above and press Enter." />
            ) : (
              <ul className="divide-y divide-border/60">
                {drugs.map((d) => (
                  <li key={d} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="flex items-center gap-2"><Pill className="h-4 w-4 text-muted-foreground" />{d}</span>
                    <StatusPill tone="neutral">Coverage: needs plan data</StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      )}

      {tab === "providers" && (
        <SectionCard title="Doctor lookup" icon={Stethoscope} description="Find the client's doctors in the national provider directory">
          <ProviderSearch onAdd={(p) => setDoctors((ds) => (ds.some((x) => x.npi === p.npi) ? ds : [...ds, p]))} added={new Set(doctors.map((d) => d.npi))} />
        </SectionCard>
      )}

      <p className="text-xs text-muted-foreground">
        Need to record a plan a client chose? Use the enrollment section on the <Link href="/crm" className="underline">client's record</Link>.
      </p>
    </div>
  );
}
