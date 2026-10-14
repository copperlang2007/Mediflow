/**
 * Agent self-serve commission portal.
 *
 * Lets an agent see THEIR OWN commission statements (rows from
 * agent_commission_payouts) and a paid-vs-pending summary — data that was
 * previously only visible to admins/managers on /commissions. The server
 * resolves the agent from the signed-in user (agentsTable.userId + orgId)
 * and only ever returns that agent's payouts.
 *
 * Gated to the `agent` role (the agent-facing counterpart to the admin
 * "Commissions" item). Anyone else who lands here (e.g. an admin following an
 * old link) gets a friendly explanation that this is the agent's personal
 * view, with a link to the agency-wide Commissions page — not an opaque
 * "no access" message that looks broken. A user with no linked agent gets a
 * clean "no statements" panel instead of an opaque 403/404.
 */
import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import {
  useMyCommissions,
  type MyCommissionStatement,
} from "@/lib/commissions/myCommissions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Wallet, CheckCircle2, Clock, UserRound, Link2Off, AlertCircle, ArrowRight } from "lucide-react";
import { format } from "date-fns";
import { PageHeader, KpiCard, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, KpiGrid, TableFrame } from "@/components/ops";

// Agent self-serve portal: scoped to the `agent` role to match the nav item
// exactly (admins/managers use the org-wide /commissions view). Keeping these
// aligned avoids a role being able to reach the route but not see the nav.
const ALLOWED_ROLES = ["agent"] as const;

// Roles that manage commissions for the whole agency — they get pointed to
// the org-wide page instead.
const ORG_COMMISSION_ROLES = new Set(["super_admin", "agency_admin", "compliance_manager", "agent_support", "developer"]);

const PAID_STATUS = "paid";

function formatMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatPeriod(start: string, end: string): string {
  try {
    return `${format(new Date(start), "MMM d, yyyy")} – ${format(
      new Date(end),
      "MMM d, yyyy",
    )}`;
  } catch {
    return `${start} – ${end}`;
  }
}

function StatusBadge({ status }: { status: string }) {
  const isPaid = status === PAID_STATUS;
  return (
    <span data-testid={`statement-status-${status}`}>
      <StatusPill status={status} tone={isPaid ? "success" : "warning"}>
        {isPaid ? "Paid" : status === "open" ? "Pending" : undefined}
      </StatusPill>
    </span>
  );
}

function StatementRow({ statement }: { statement: MyCommissionStatement }) {
  const isPaid = statement.status === PAID_STATUS;
  return (
    <TableRow data-testid={`statement-row-${statement.id}`}>
      <TableCell className="font-medium">
        {formatPeriod(statement.periodStart, statement.periodEnd)}
      </TableCell>
      <TableCell className={`text-right tabular-nums font-semibold ${isPaid ? "text-success" : ""}`}>
        {formatMoney(isPaid ? statement.paid : statement.earned)}
      </TableCell>
      <TableCell className="text-center">
        <StatusBadge status={statement.status} />
      </TableCell>
      <TableCell className="text-right text-muted-foreground tabular-nums">
        {statement.paidAt
          ? format(new Date(statement.paidAt), "MMM d, yyyy")
          : "—"}
      </TableCell>
    </TableRow>
  );
}

const HEADER = (
  <PageHeader
    title="My Commissions"
    subtitle="What you've been paid, and what's still on its way"
  />
);

export default function MyCommissionsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const allowed = !!me && ALLOWED_ROLES.includes(me.role as never);

  const query = useMyCommissions(allowed);
  const statements = query.data?.data ?? [];
  const summary = query.data?.summary;

  if (!meLoading && !allowed) {
    const managesOrg = !!me && ORG_COMMISSION_ROLES.has(me.role);
    return (
      <PageShell>
        {HEADER}
        <SectionCard>
          <EmptyState
            icon={UserRound}
            title="This is each agent's personal commission view"
            description={
              managesOrg
                ? "Agents see their own statements here once they sign in. To see commissions for the whole agency — statements, payouts and anything unpaid — use the Commissions page."
                : "Agents see their own commission statements here once they sign in. Your role doesn't have a personal commission account."
            }
          >
            {managesOrg && (
              <Button asChild size="sm">
                <Link href="/commissions">
                  Open agency Commissions
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </EmptyState>
        </SectionCard>
      </PageShell>
    );
  }

  // Distinguish "no agent record linked" (404) from a genuine load failure, so
  // an agent without a commission account sees an explanatory panel rather than
  // a misleading "$0 / no statements" view or an opaque error.
  if (query.isError) {
    const status = (query.error as { status?: number } | null)?.status;
    return (
      <PageShell>
        {HEADER}
        <SectionCard>
          <div data-testid="my-commissions-error">
            {status === 404 ? (
              <EmptyState
                icon={Link2Off}
                title="Your commission account isn't set up yet"
                description="No commission account is linked to your profile yet. Contact your agency admin if you expect to see commissions here."
              />
            ) : (
              <EmptyState
                icon={AlertCircle}
                title="We couldn't load your commissions"
                description="Couldn't load your commissions right now. Please try again shortly."
                action={{ label: "Try again", onClick: () => void query.refetch() }}
              />
            )}
          </div>
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      {HEADER}

      {query.isLoading ? (
        <div className="space-y-5" data-testid="my-commissions-loading">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <KpiGrid cols={2}>
            <div data-testid="summary-paid">
              <KpiCard
                label="Paid to you"
                value={formatMoney(summary?.totalPaid ?? 0)}
                icon={CheckCircle2}
                color="green"
                hint={`${summary?.paidCount ?? 0} statement${(summary?.paidCount ?? 0) === 1 ? "" : "s"} paid`}
              />
            </div>
            <div data-testid="summary-pending">
              <KpiCard
                label="On its way"
                value={formatMoney(summary?.totalPending ?? 0)}
                icon={Clock}
                color="blue"
                hint={`${summary?.pendingCount ?? 0} statement${(summary?.pendingCount ?? 0) === 1 ? "" : "s"} earned, not yet paid`}
              />
            </div>
          </KpiGrid>

          <SectionCard
            title="Your statements"
            description="One line per pay period, newest first"
            icon={Wallet}
          >
            {statements.length === 0 ? (
              <div data-testid="my-commissions-empty">
                <EmptyState
                  icon={Wallet}
                  title="You have no commission statements yet."
                  description="When a carrier pays on one of your policies and your agency reconciles the statement, it will show up here."
                />
              </div>
            ) : (
              <TableFrame>
                <Table data-testid="my-commissions-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                      <TableHead className="text-right">Paid date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statements.map((s) => (
                      <StatementRow key={s.id} statement={s} />
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </SectionCard>
        </>
      )}
    </PageShell>
  );
}
