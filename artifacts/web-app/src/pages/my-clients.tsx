/**
 * My clients: an agent's own book, for servicing it.
 *
 * Lists the contacts assigned to the signed-in agent or holding a policy
 * they wrote (`GET /api/agents/me/clients`). Opening a client shows their
 * details with PHI (date of birth, Medicare ID, health conditions), their
 * policies and their enrollment applications; the full application opens in
 * the same audited dialog admins use. The server resolves the agent from the
 * session and only returns that agent's clients.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, HeartPulse, Mail, Phone, Search, ShieldAlert, Users } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { PageShell } from "@/components/ops";
import { FullApplicationDialog } from "@/pages/crm/ApplicationsTab";

type ClientRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  stateCode: string | null;
  status: string;
  currentPlanType: string | null;
  dob: string | null;
};

type ClientDetail = {
  contact: ClientRow & {
    medicareId: string | null;
    healthConditions: string[] | null;
    address1: string | null;
    zipCode: string | null;
    county: string | null;
    pcpName: string | null;
    preferredLanguage: string | null;
  };
  policies: {
    id: string;
    carrierName: string | null;
    planName: string | null;
    planId: string | null;
    planType: string;
    planYear: number;
    policyNumber: string | null;
    effectiveDate: string | null;
    status: string;
    writtenByMe: boolean;
  }[];
  applications: {
    id: string;
    confirmationCode: string | null;
    carrierName: string | null;
    planName: string | null;
    policyStatus: string | null;
    effectiveDate: string | null;
    currentVersion: number;
    canViewFull: boolean;
  }[];
};

const PAGE_SIZE = 50;

/** A date-only value ("1951-03-07T00:00:00.000Z") as the calendar date, never shifted by time zone. */
function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  const [y, m, d] = v.slice(0, 10).split("-");
  return y && m && d ? `${Number(m)}/${Number(d)}/${y}` : null;
}

function errorText(err: unknown): string {
  const message = (err as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof message === "string" && message ? message : "Couldn't load your clients. Please retry.";
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ClientSheet({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [openApp, setOpenApp] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/agents/me/clients", clientId],
    queryFn: () => customFetch<ClientDetail>(`/api/agents/me/clients/${clientId}`),
    retry: false,
  });
  const c = data?.contact;

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{c ? `${c.firstName} ${c.lastName}` : "Client"}</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> Protected health information: use it only to service this client.
          </SheetDescription>
        </SheetHeader>
        {isLoading && <Skeleton className="mt-4 h-64 w-full" />}
        {error && <p className="mt-4 text-sm text-destructive">{errorText(error)}</p>}
        {c && data && (
          <div className="mt-4 space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              {c.phone && (
                <Button asChild size="sm" variant="outline"><a href={`tel:${c.phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />{c.phone}</a></Button>
              )}
              {c.email && (
                <Button asChild size="sm" variant="outline"><a href={`mailto:${c.email}`} className="max-w-full truncate"><Mail className="mr-1.5 h-3.5 w-3.5" />{c.email}</a></Button>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Date of birth</dt><dd>{dateOnly(c.dob) ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Medicare ID</dt><dd className="font-mono">{c.medicareId ?? "—"}</dd></div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Address</dt>
                <dd>{[c.address1, [c.city, c.stateCode].filter(Boolean).join(", "), c.zipCode].filter(Boolean).join(" · ") || "—"}{c.county ? ` (${c.county} County)` : ""}</dd>
              </div>
              <div><dt className="text-muted-foreground">Primary care doctor</dt><dd>{c.pcpName ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Language</dt><dd>{c.preferredLanguage ?? "—"}</dd></div>
            </dl>

            <div>
              <p className="mb-2 flex items-center gap-1.5 font-medium"><HeartPulse className="h-4 w-4 text-accent" />Health conditions</p>
              {c.healthConditions && c.healthConditions.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.healthConditions.map((h) => <StatusPill key={h} tone="navy">{h}</StatusPill>)}
                </div>
              ) : (
                <p className="text-muted-foreground">None on file.</p>
              )}
            </div>

            <div>
              <p className="mb-2 font-medium">Policies</p>
              {data.policies.length === 0 ? (
                <p className="text-muted-foreground">No policies on file.</p>
              ) : (
                <ul className="space-y-2">
                  {data.policies.map((p) => (
                    <li key={p.id} className="rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.planName ?? p.planType}</span>
                        <StatusPill status={p.status}>{p.status}</StatusPill>
                        {p.writtenByMe && <StatusPill tone="navy">Written by you</StatusPill>}
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {[p.carrierName, p.planId, `${p.planType} ${p.planYear}`, p.effectiveDate ? `Effective ${dateOnly(p.effectiveDate)}` : null, p.policyNumber ? `Policy ${p.policyNumber}` : null]
                          .filter(Boolean).join(" · ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-2 font-medium">Applications</p>
              {data.applications.length === 0 ? (
                <p className="text-muted-foreground">No enrollment applications on file.</p>
              ) : (
                <ul className="space-y-2">
                  {data.applications.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3">
                      <div className="min-w-0">
                        <p className="font-medium">{a.planName ?? "Unnamed plan"}</p>
                        <p className="text-muted-foreground">
                          {[a.carrierName, a.effectiveDate ? `Effective ${dateOnly(a.effectiveDate)}` : null, a.confirmationCode ? `Sunfire ${a.confirmationCode}` : null]
                            .filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      {a.canViewFull && (
                        <Button size="sm" variant="outline" onClick={() => setOpenApp(a.id)}>
                          <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />Full application
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {data.applications.some((a) => a.canViewFull) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  The full application includes the health answers. Every time it is opened, that is recorded in the audit log.
                </p>
              )}
            </div>
          </div>
        )}
        {openApp && <FullApplicationDialog applicationId={openApp} onClose={() => setOpenApp(null)} />}
      </SheetContent>
    </Sheet>
  );
}

export default function MyClientsPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(search.trim(), 300);
  useEffect(() => setPage(0), [q]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/agents/me/clients", q, page],
    queryFn: () => customFetch<{ data: ClientRow[]; total: number }>(
      `/api/agents/me/clients?${new URLSearchParams({ search: q, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })}`,
    ),
    retry: false,
  });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageShell>
      <PageHeader title="My clients" subtitle="Clients assigned to you and clients whose policies you wrote." />
      <SectionCard
        title={data ? `${total.toLocaleString()} client${total === 1 ? "" : "s"}` : "Clients"}
        icon={Users}
        description="Open a client to see their Medicare ID, health conditions, policies and applications."
      >
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone or email"
            className="pl-8"
            aria-label="Search clients"
          />
        </div>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <EmptyState compact icon={Users} title="Couldn't load your clients" description={errorText(error)} />
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            compact
            icon={FileText}
            title={q ? "No clients match" : "No clients yet"}
            description={q ? "Try a different name, phone number or email." : "Clients appear here once they are assigned to you or a policy you wrote comes in."}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Phone</TableHead>
                    <TableHead className="hidden lg:table-cell">Location</TableHead>
                    <TableHead className="hidden sm:table-cell">Date of birth</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => setOpenId(c.id)}>
                      <TableCell>
                        <button type="button" className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(c.id); }}>
                          {c.lastName}, {c.firstName}
                        </button>
                        {c.currentPlanType && <span className="ml-2 text-xs text-muted-foreground">{c.currentPlanType}</span>}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{c.phone ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">{[c.city, c.stateCode].filter(Boolean).join(", ") || "—"}</TableCell>
                      <TableCell className="hidden sm:table-cell">{dateOnly(c.dob) ?? "—"}</TableCell>
                      <TableCell><StatusPill status={c.status}>{c.status.replace(/_/g, " ")}</StatusPill></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {pages > 1 && (
              <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>Page {page + 1} of {pages}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                  <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>
      {openId && <ClientSheet clientId={openId} onClose={() => setOpenId(null)} />}
    </PageShell>
  );
}
