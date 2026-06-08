/**
 * Agent self-serve commission portal.
 *
 * Lets an agent see THEIR OWN commission statements (rows from
 * agent_commission_payouts) and a paid-vs-pending summary — data that was
 * previously only visible to admins/managers on /commissions. The server
 * resolves the agent from the Clerk session (agentsTable.userId + orgId)
 * and only ever returns that agent's payouts.
 *
 * Gated to the `agent` role (the agent-facing counterpart to the admin
 * "Commissions" item). Admins linked to an agent record may also view it —
 * they'll see their own statements. A user with no linked agent gets a
 * clean "no statements" panel instead of an opaque 403/404.
 */
import { useGetMe } from "@workspace/api-client-react";
import {
  useMyCommissions,
  type MyCommissionStatement,
} from "@/lib/commissions/myCommissions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Wallet, CheckCircle2, Clock } from "lucide-react";
import { format } from "date-fns";

// Roles allowed to see this page. Agents are the primary audience; admins
// are permitted too (they'll see their own statements if linked).
const ALLOWED_ROLES = [
  "agent",
  "super_admin",
  "agency_admin",
  "compliance_manager",
] as const;

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
    <Badge
      variant={isPaid ? "default" : "secondary"}
      className={isPaid ? "bg-green-600 hover:bg-green-600" : ""}
      data-testid={`statement-status-${status}`}
    >
      {status}
    </Badge>
  );
}

function SummaryCard({
  label,
  value,
  count,
  icon: Icon,
  accent,
  testId,
}: {
  label: string;
  value: string;
  count: number;
  icon: typeof Wallet;
  accent: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {count} statement{count === 1 ? "" : "s"}
            </p>
          </div>
          <Icon className={`h-8 w-8 ${accent}`} />
        </div>
      </CardContent>
    </Card>
  );
}

function StatementRow({ statement }: { statement: MyCommissionStatement }) {
  const isPaid = statement.status === PAID_STATUS;
  return (
    <TableRow data-testid={`statement-row-${statement.id}`}>
      <TableCell className="font-medium">
        {formatPeriod(statement.periodStart, statement.periodEnd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
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

export default function MyCommissionsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const allowed = !!me && ALLOWED_ROLES.includes(me.role as never);

  const query = useMyCommissions(allowed);
  const statements = query.data?.data ?? [];
  const summary = query.data?.summary;

  if (!meLoading && !allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have access to commission statements.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wallet className="h-6 w-6 text-emerald-600" />
          My Commissions
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your commission statements and paid-vs-pending totals
        </p>
      </div>

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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryCard
              label="Paid"
              value={formatMoney(summary?.totalPaid ?? 0)}
              count={summary?.paidCount ?? 0}
              icon={CheckCircle2}
              accent="text-green-600"
              testId="summary-paid"
            />
            <SummaryCard
              label="Pending"
              value={formatMoney(summary?.totalPending ?? 0)}
              count={summary?.pendingCount ?? 0}
              icon={Clock}
              accent="text-amber-500"
              testId="summary-pending"
            />
          </div>

          <Card>
            <CardContent className="p-0">
              {statements.length === 0 ? (
                <div
                  className="py-16 text-center text-sm text-muted-foreground"
                  data-testid="my-commissions-empty"
                >
                  You have no commission statements yet.
                </div>
              ) : (
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
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
