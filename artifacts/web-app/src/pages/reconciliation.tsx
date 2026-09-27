/**
 * Commission Reconciliation (agencyBRIDGE ReconciliationPage) built on the
 * real commissions pipeline:
 *   - GET /api/commissions/reconciliation/overview — statement variance,
 *     unmatched line items, open missed-payment alerts;
 *   - GET /api/clawbacks/summary — chargebacks over the last 12 months;
 *   - statement upload + parse via the existing UploadStatementDialog.
 *
 * Disputes aging, the 1099 rollup and the GL export have no engine yet, so
 * they are shown as clearly labelled "Coming soon" panels with no numbers.
 */
import { useState, type ComponentType } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CalendarX,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Link2Off,
  Receipt,
  RotateCcw,
  Scale,
  Timer,
  Upload,
} from "lucide-react";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, KpiCard, PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { cn } from "@/lib/utils";
import { UploadStatementDialog } from "@/pages/commissions";

type Overview = {
  statements: Array<{
    id: string;
    carrierName: string | null;
    statementDate: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    totalAmount: number | null;
    lineItemCount: number;
    unmatchedCount: number;
    lineItemTotal: number;
    variance: number | null;
  }>;
  totals: {
    statements: number;
    statementsPending: number;
    statementsParsed: number;
    statementsReconciled: number;
    lineItems: number;
    matched: number;
    manual: number;
    unmatched: number;
    unmatchedAmount: number;
    statementsWithVariance: number;
    varianceAmount: number;
    openMissedPayments: number;
    missedExpectedAmount: number;
  };
  unmatchedItems: Array<{
    id: string;
    statementId: string;
    carrierName: string | null;
    policyNumber: string | null;
    planType: string | null;
    periodStart: string | null;
    commissionAmount: number;
    type: string;
  }>;
  missedPayments: Array<{
    id: string;
    contactId: string;
    contactName: string | null;
    policyNumber: string | null;
    expectedAmount: number | null;
    expectedPeriod: string | null;
    detectedAt: string;
    daysOpen: number;
  }>;
};

type ClawbackSummary = { clawbackTotal: number; chargebackCount: number; windowDays: number };

const UPLOAD_ROLES = ["super_admin", "agency_admin"];

/** Carriers with a statement parser today (api-server lib/commissionParsers). */
const SUPPORTED_CARRIERS = ["Aetna / CVS Health", "Anthem / Blue Cross", "Humana", "UnitedHealthcare / AARP"];

const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const usdShort = (n: number) =>
  Math.abs(n) >= 10_000
    ? `$${(n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`
    : usd(n);

function day(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

export default function ReconciliationPage() {
  const qc = useQueryClient();
  const { data: me } = useGetMe();
  const canUpload = UPLOAD_ROLES.includes(me?.role ?? "");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tab, setTab] = useState("variance");

  const overview = useQuery({
    queryKey: ["/api/commissions/reconciliation/overview"],
    queryFn: () => customFetch<Overview>("/api/commissions/reconciliation/overview"),
  });
  const clawbacks = useQuery({
    queryKey: ["/api/clawbacks/summary", 365],
    queryFn: () => customFetch<ClawbackSummary>("/api/clawbacks/summary?days=365"),
  });

  const data = overview.data;
  const t = data?.totals;
  const varianceStatements = (data?.statements ?? []).filter((s) => s.variance != null && Math.abs(s.variance) >= 0.01);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Commission Reconciliation"
        subtitle="Check carrier statements against your book: totals that don't add up, lines we couldn't match, and payments that never arrived"
      >
        <Button variant="outline" size="sm" asChild>
          <Link href="/commissions">
            <FileText className="mr-1.5 h-4 w-4" /> All statements
          </Link>
        </Button>
        {canUpload && (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" /> Upload statement
          </Button>
        )}
      </PageHeader>

      {/* Real alerts only: statements whose stated total differs from their lines. */}
      {varianceStatements.slice(0, 3).map((s) => (
        <AlertBanner
          key={s.id}
          icon={Scale}
          title="Statement total doesn't match its lines"
          detail={`${s.carrierName ?? "Carrier"} statement for ${day(s.periodStart)} – ${day(s.periodEnd)} says ${usd(s.totalAmount)}, but its lines add up to ${usd(s.lineItemTotal)} (a ${usd(Math.abs(s.variance ?? 0))} difference).`}
          href={`/commissions/statements/${s.id}`}
        />
      ))}
      {t && t.openMissedPayments > 0 && (
        <AlertBanner
          icon={CalendarX}
          title="Expected commissions haven't arrived"
          detail={`${t.openMissedPayments} expected ${t.openMissedPayments === 1 ? "payment is" : "payments are"} missing from carrier statements, worth ${usd(t.missedExpectedAmount)} in total.`}
          onClick={() => setTab("missed")}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Statements" value={t?.statements ?? 0} icon={FileSpreadsheet} color="navy" loading={overview.isLoading}
          hint={t ? `${t.statementsReconciled} reconciled · ${t.statementsPending + t.statementsParsed} to finish` : undefined} />
        <KpiCard label="Lines not matched" value={t?.unmatched ?? 0} icon={Link2Off} color="orange" loading={overview.isLoading}
          hint={t ? `${usd(t.unmatchedAmount)} waiting to be matched` : undefined} />
        <KpiCard label="Missed payments" value={t?.openMissedPayments ?? 0} icon={CalendarX} color="blue" loading={overview.isLoading}
          hint={t ? `${usd(t.missedExpectedAmount)} expected` : undefined} />
        <KpiCard label="Clawed back (12 months)" value={clawbacks.data ? usdShort(clawbacks.data.clawbackTotal) : "$0"} icon={RotateCcw} color="green"
          loading={clawbacks.isLoading} href="/clawbacks"
          hint={clawbacks.data ? `${clawbacks.data.chargebackCount} chargeback ${clawbacks.data.chargebackCount === 1 ? "line" : "lines"}` : undefined} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="variance">Variance by statement</TabsTrigger>
          <TabsTrigger value="unmatched">Unmatched lines{t ? ` (${t.unmatched})` : ""}</TabsTrigger>
          <TabsTrigger value="missed">Missed payments{t ? ` (${t.openMissedPayments})` : ""}</TabsTrigger>
          <TabsTrigger value="upload">Statement upload</TabsTrigger>
          <TabsTrigger value="disputes">Disputes &amp; aging</TabsTrigger>
          <TabsTrigger value="1099">1099 rollup</TabsTrigger>
          <TabsTrigger value="gl">GL export</TabsTrigger>
        </TabsList>

        <TabsContent value="variance" className="mt-4">
          <SectionCard title="Variance by statement" description="The carrier's stated total compared with the lines we read from the file (latest 50 statements).">
            {overview.isLoading ? <TableSkeleton /> : overview.isError ? <LoadError /> : !data || data.statements.length === 0 ? (
              <EmptyState icon={FileSpreadsheet} title="No statements uploaded yet"
                description="Upload a carrier commission statement and we'll read each line and check it against your book."
                action={canUpload ? { label: "Upload a statement", onClick: () => setUploadOpen(true) } : undefined} />
            ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead>Carrier</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Stated total</TableHead>
                      <TableHead className="text-right">Lines add up to</TableHead>
                      <TableHead className="text-right">Difference</TableHead>
                      <TableHead className="text-right">Unmatched</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.statements.map((s) => {
                      const off = s.variance != null && Math.abs(s.variance) >= 0.01;
                      return (
                        <TableRow key={s.id} className="hover:bg-muted/30">
                          <TableCell className="font-medium text-sm">{s.carrierName ?? "—"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{day(s.periodStart)} – {day(s.periodEnd)}</TableCell>
                          <TableCell><StatusPill status={s.status} /></TableCell>
                          <TableCell className="text-right text-sm">{usd(s.totalAmount)}</TableCell>
                          <TableCell className="text-right text-sm">{s.lineItemCount > 0 ? usd(s.lineItemTotal) : <span className="text-muted-foreground">Not read yet</span>}</TableCell>
                          <TableCell className={cn("text-right text-sm font-medium", off ? "text-warning" : "text-success")}>
                            {s.variance == null ? <span className="text-muted-foreground font-normal">—</span> : off ? usd(s.variance) : "Matches"}
                          </TableCell>
                          <TableCell className={cn("text-right text-sm", s.unmatchedCount > 0 && "font-medium text-destructive")}>{s.unmatchedCount}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" asChild>
                              <Link href={`/commissions/statements/${s.id}`}>Open <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="unmatched" className="mt-4">
          <SectionCard title="Lines we couldn't match" description="Statement lines that didn't match a client or agent in your book. Open the statement to match them by hand.">
            {overview.isLoading ? <TableSkeleton /> : overview.isError ? <LoadError /> : !data || data.unmatchedItems.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Everything is matched" description="Every statement line we've read is tied to a client in your book." />
            ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead>Carrier</TableHead>
                      <TableHead>Policy #</TableHead>
                      <TableHead>Plan type</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.unmatchedItems.map((li) => (
                      <TableRow key={li.id} className="hover:bg-muted/30">
                        <TableCell className="text-sm font-medium">{li.carrierName ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{li.policyNumber ?? "—"}</TableCell>
                        <TableCell className="text-sm">{li.planType ?? "—"}</TableCell>
                        <TableCell><StatusPill tone={li.type === "chargeback" ? "danger" : "neutral"}>{li.type}</StatusPill></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{day(li.periodStart)}</TableCell>
                        <TableCell className={cn("text-right text-sm font-medium", li.commissionAmount < 0 ? "text-destructive" : "text-foreground")}>{usd(li.commissionAmount)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/commissions/statements/${li.statementId}`}>Match <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="missed" className="mt-4">
          <SectionCard title="Missed payments" description="Commissions we expected on a statement but didn't find. Oldest alerts are the most urgent to chase.">
            {overview.isLoading ? <TableSkeleton /> : overview.isError ? <LoadError /> : !data || data.missedPayments.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="No missed payments" description="When an expected commission doesn't show up on a statement, it appears here." />
            ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead>Client</TableHead>
                      <TableHead>Policy #</TableHead>
                      <TableHead>For period</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Open for</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.missedPayments.map((m) => (
                      <TableRow key={m.id} className="hover:bg-muted/30">
                        <TableCell className="text-sm font-medium">
                          <Link href={`/crm/contacts/${m.contactId}`} className="hover:text-accent hover:underline underline-offset-2">{m.contactName ?? "Client"}</Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{m.policyNumber ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{day(m.expectedPeriod)}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{usd(m.expectedAmount)}</TableCell>
                        <TableCell className={cn("text-right text-sm", m.daysOpen > 30 ? "font-medium text-destructive" : m.daysOpen > 14 ? "text-warning" : "text-muted-foreground")}>
                          {m.daysOpen} {m.daysOpen === 1 ? "day" : "days"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="upload" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <SectionCard className="lg:col-span-2" title="Upload a carrier statement" icon={Upload}
              description="Drop in the CSV or spreadsheet your carrier sends. We read every line, match it to your clients and agents, and flag anything that doesn't add up.">
              <div className="rounded-xl border-2 border-dashed border-border bg-muted/30 p-8 text-center">
                <FileSpreadsheet className="mx-auto h-10 w-10 text-accent" />
                <p className="mt-3 text-sm font-medium">Carrier statement file (CSV)</p>
                <p className="mt-1 text-xs text-muted-foreground">You'll pick the carrier, the pay period and the statement total, then we read the file.</p>
                {canUpload ? (
                  <Button className="mt-4" onClick={() => setUploadOpen(true)}><Upload className="mr-1.5 h-4 w-4" /> Choose a file</Button>
                ) : (
                  <p className="mt-4 text-xs text-muted-foreground">Only agency owners can upload statements.</p>
                )}
              </div>
            </SectionCard>
            <SectionCard title="Carriers we can read" icon={BookOpen} description="Statement formats with a built-in reader today.">
              <ul className="space-y-2">
                {SUPPORTED_CARRIERS.map((c) => (
                  <li key={c} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0" /> {c}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">Other carriers' files can't be read automatically yet.</p>
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="disputes" className="mt-4">
          <ComingSoon icon={Timer} title="Disputes & aging"
            body="Open a dispute with a carrier straight from a mismatched line, then track how long each one has been waiting for an answer. Until then, use the Missed payments tab to see what's outstanding." />
        </TabsContent>
        <TabsContent value="1099" className="mt-4">
          <ComingSoon icon={Receipt} title="1099 rollup"
            body="Add up each agent's paid commissions for the year and compare them with what will be reported on their 1099, so you can fix differences before tax season." />
        </TabsContent>
        <TabsContent value="gl" className="mt-4">
          <ComingSoon icon={FileSpreadsheet} title="General ledger export"
            body="Turn reconciled statements into journal entries you can import into your accounting software." />
        </TabsContent>
      </Tabs>

      {canUpload && (
        <UploadStatementDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          onUploaded={() => void qc.invalidateQueries({ queryKey: ["/api/commissions/reconciliation/overview"] })}
        />
      )}
    </div>
  );
}

function AlertBanner({
  icon: Icon,
  title,
  detail,
  href,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  href?: string;
  onClick?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning/20 text-warning">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-800 dark:text-warning flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5" /> {title}
        </p>
        <p className="mt-0.5 text-sm text-foreground/80">{detail}</p>
      </div>
      {href ? (
        <Button variant="outline" size="sm" className="shrink-0 bg-card" asChild>
          <Link href={href}>Investigate</Link>
        </Button>
      ) : onClick ? (
        <Button variant="outline" size="sm" className="shrink-0 bg-card" onClick={onClick}>Review</Button>
      ) : null}
    </div>
  );
}

function ComingSoon({ icon: Icon, title, body }: { icon: ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <SectionCard>
      <EmptyState icon={Icon} title={<span className="flex items-center gap-2 justify-center">{title} <StatusPill tone="info">Coming soon</StatusPill></span>} description={body} />
    </SectionCard>
  );
}

function TableSkeleton() {
  return <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>;
}

function LoadError() {
  return <EmptyState icon={AlertTriangle} title="Couldn't load reconciliation data" description="Please refresh the page." />;
}
