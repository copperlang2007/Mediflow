/**
 * Admin "Ready to Sell" readiness board.
 *
 * The admin-facing inverse of the inbound router's eligibility predicate: per
 * agent, what makes them ready to sell and what's blocking them. Admins use it
 * to drive onboarding completion and grow the routable pool.
 *
 * Restricted to `ADMIN_OR_COMPLIANCE_ROLES`. Non-admins see a clean "no access"
 * panel; the API also enforces `agent:read`. Data comes from the hand-rolled
 * `useAgentReadiness` hook (GET /api/agents/readiness).
 */
import { useMemo, useState } from "react";
import {
  useAgentReadiness,
  useCredentialExpiry,
  type AgentReadiness,
  type ExpiringCredential,
  type ExpiryTier,
  type CredentialType,
} from "@/lib/readiness/api";
import {
  useIsAdmin,
  ADMIN_OR_COMPLIANCE_ROLES,
} from "@/lib/auth/useIsAdmin";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { CheckCircle2, XCircle, AlertCircle, Clock, UserCheck, UserX, AlarmClock, CalendarClock, Lock, Target } from "lucide-react";
import { EmptyState, KpiCard, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/shared";
import { ContactAvatar } from "@/pages/crm/ui";

// Tier → text/border colors (most → least urgent).
const TIER_STYLES: Record<ExpiryTier, string> = {
  expired: "text-red-700 border-red-300 bg-red-50",
  critical: "text-red-700 border-red-300 bg-red-50",
  soon: "text-amber-700 border-amber-300 bg-amber-50",
  upcoming: "text-blue-700 border-blue-300 bg-blue-50",
};

const TIER_TONE: Record<ExpiryTier, StatusTone> = {
  expired: "danger",
  critical: "danger",
  soon: "warning",
  upcoming: "info",
};

const TIER_LABEL: Record<ExpiryTier, string> = {
  expired: "Expired",
  critical: "Critical",
  soon: "Soon",
  upcoming: "Upcoming",
};

const CRED_TYPE_LABEL: Record<CredentialType, string> = {
  license: "State license",
  carrier_cert: "Carrier cert",
  ahip: "AHIP",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function ExpiryRow({ cred }: { cred: ExpiringCredential }) {
  return (
    <TableRow data-testid={`expiry-row-${cred.agentId}-${cred.type}-${cred.label}`}>
      <TableCell className="font-medium">{cred.agentName}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {CRED_TYPE_LABEL[cred.type]}
      </TableCell>
      <TableCell>{cred.label}</TableCell>
      <TableCell className="tabular-nums">{formatDate(cred.expiryDate)}</TableCell>
      <TableCell>
        <StatusPill tone={TIER_TONE[cred.tier]} className="tabular-nums">
          {cred.daysUntil < 0
            ? `${Math.abs(cred.daysUntil)} days ago`
            : `in ${cred.daysUntil} day${cred.daysUntil === 1 ? "" : "s"}`} · {TIER_LABEL[cred.tier]}
        </StatusPill>
      </TableCell>
    </TableRow>
  );
}

function ReadyBadge({ ready }: { ready: boolean }) {
  return ready ? (
    <span data-testid="ready-badge-yes">
      <StatusPill tone="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Ready
      </StatusPill>
    </span>
  ) : (
    <span data-testid="ready-badge-no">
      <StatusPill tone="danger" className="gap-1">
        <XCircle className="h-3 w-3" />
        Not ready
      </StatusPill>
    </span>
  );
}

function AhipCell({ current }: { current: boolean }) {
  return current ? (
    <span className="inline-flex items-center gap-1 text-success text-sm">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Current
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-warning text-sm">
      <AlertCircle className="h-3.5 w-3.5" />
      Missing
    </span>
  );
}

function ReadinessRow({ agent }: { agent: AgentReadiness }) {
  return (
    <TableRow data-testid={`readiness-row-${agent.agentId}`}>
      <TableCell>
        <div className="flex items-center gap-3">
          <ContactAvatar first={agent.firstName} last={agent.lastName} size="sm" />
          <div className="min-w-0">
            <p className="font-medium">{agent.firstName} {agent.lastName}</p>
            {agent.npn && <p className="text-xs text-muted-foreground">NPN {agent.npn}</p>}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <ReadyBadge ready={agent.readyToSell} />
      </TableCell>
      <TableCell>
        <AhipCell current={agent.ahipCurrent} />
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {agent.licensedStates.length}
      </TableCell>
      <TableCell className="text-center tabular-nums">
        {agent.certifiedCarriers.length}
      </TableCell>
      <TableCell>
        {agent.blockers.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {agent.blockers.map((b) => (
              <StatusPill key={b} tone="warning">{b}</StatusPill>
            ))}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function ReadinessPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(
    ADMIN_OR_COMPLIANCE_ROLES,
  );
  const [notReadyOnly, setNotReadyOnly] = useState(false);
  const [withinDays, setWithinDays] = useState(60);

  const readinessQuery = useAgentReadiness(undefined, Boolean(isAdmin));
  const agents = readinessQuery.data?.data ?? [];

  const expiryQuery = useCredentialExpiry(withinDays, Boolean(isAdmin));
  const expiring = expiryQuery.data?.data ?? [];
  const expiryCounts =
    expiryQuery.data?.counts ?? { critical: 0, soon: 0, upcoming: 0 };

  const rows = useMemo(
    () => (notReadyOnly ? agents.filter((a) => !a.readyToSell) : agents),
    [agents, notReadyOnly],
  );

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <Card>
          <EmptyState
            icon={Lock}
            title="Ready to Sell is for admins"
            description="You don't have access to the readiness board. Ask an agency admin or compliance manager if you need it."
          />
        </Card>
      </div>
    );
  }

  const readyCount = readinessQuery.data?.readyCount ?? 0;
  const totalCount = readinessQuery.data?.totalCount ?? 0;
  const certYear = readinessQuery.data?.certificationYear;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Ready to Sell"
        subtitle={`Which agents can take calls and sell right now, and what's stopping the rest${certYear ? ` · ${certYear} certification year` : ""}`}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div data-testid="readiness-summary" className="contents">
          <KpiCard
            color="green" icon={UserCheck}
            label="Ready to sell"
            value={readyCount}
            hint={`of ${totalCount} agents ready to sell`}
            loading={readinessQuery.isLoading}
          />
        </div>
        <KpiCard
          color="orange" icon={UserX}
          label="Not ready yet"
          value={Math.max(0, totalCount - readyCount)}
          hint="See what's blocking them below"
          loading={readinessQuery.isLoading}
        />
        <KpiCard
          color="navy" icon={AlarmClock}
          label="Expiring within 7 days"
          value={expiryCounts.critical}
          hint="Licenses & certs"
          loading={expiryQuery.isLoading}
        />
        <KpiCard
          color="blue" icon={CalendarClock}
          label="Expiring within 30 days"
          value={expiryCounts.soon}
          hint="Renew before they lapse"
          loading={expiryQuery.isLoading}
        />
      </div>

      <SectionCard
        title="Agent readiness"
        description="An agent is ready when they are active, have a current AHIP, at least one state license and at least one carrier certification."
        icon={Target}
        contentClassName="px-0 pb-0"
        actions={
          <div className="flex items-center gap-2">
            <Switch
              id="not-ready-only"
              checked={notReadyOnly}
              onCheckedChange={setNotReadyOnly}
              data-testid="not-ready-only-toggle"
            />
            <Label htmlFor="not-ready-only" className="text-sm whitespace-nowrap">
              Not ready only
            </Label>
          </div>
        }
      >
        <div className="border-t border-border">
          {readinessQuery.isLoading ? (
            <div className="p-4 space-y-2" data-testid="readiness-loading">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            notReadyOnly ? (
              <EmptyState compact icon={CheckCircle2} title="Everyone is ready to sell" description="No agent has anything blocking them right now." />
            ) : (
              <EmptyState compact icon={Target} title="No agents yet" description="Once you add agents, you'll see here whether each one is ready to sell." action={{ label: "Go to Agents", href: "/agents" }} />
            )
          ) : (
            <Table data-testid="readiness-table">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Ready</TableHead>
                  <TableHead>AHIP</TableHead>
                  <TableHead className="text-center"># States</TableHead>
                  <TableHead className="text-center"># Carriers</TableHead>
                  <TableHead>Blockers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <ReadinessRow key={a.agentId} agent={a} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SectionCard>

      {/* Expiring soon — forward-looking early warning */}
      <SectionCard
        title="Expiring soon"
        description="Licenses and carrier certifications about to run out. Renew them before the agent stops getting calls."
        icon={Clock}
        iconClassName="text-warning"
        contentClassName="px-0 pb-0"
        actions={
        <ToggleGroup
          type="single"
          value={String(withinDays)}
          onValueChange={(v) => {
            if (v) setWithinDays(Number(v));
          }}
          data-testid="expiry-window-toggle"
        >
          <ToggleGroupItem value="30" aria-label="30 days">
            30d
          </ToggleGroupItem>
          <ToggleGroupItem value="60" aria-label="60 days">
            60d
          </ToggleGroupItem>
          <ToggleGroupItem value="90" aria-label="90 days">
            90d
          </ToggleGroupItem>
        </ToggleGroup>
        }
      >
      {/* Tier summary counts */}
      <div className="flex flex-wrap gap-2 px-5 pb-4" data-testid="expiry-summary">
        {(
          [
            ["critical", expiryCounts.critical, "within 7 days"],
            ["soon", expiryCounts.soon, "within 30 days"],
            ["upcoming", expiryCounts.upcoming, "later"],
          ] as const
        ).map(([tier, count, sub]) => (
          <StatusPill key={tier} tone={TIER_TONE[tier]} className="px-3 py-1 text-sm">
            <span className="font-semibold tabular-nums mr-1">{count}</span> {TIER_LABEL[tier].toLowerCase()} · {sub}
          </StatusPill>
        ))}
      </div>

        <div className="border-t border-border">
          {expiryQuery.isLoading ? (
            <div className="p-4 space-y-2" data-testid="expiry-loading">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : expiring.length === 0 ? (
            <div data-testid="expiry-empty">
              <EmptyState compact icon={CheckCircle2} title="Nothing expiring soon" description={`No licenses or certifications run out in the next ${withinDays} days.`} />
            </div>
          ) : (
            <Table data-testid="expiry-table">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Days until</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expiring.map((c) => (
                  <ExpiryRow
                    key={`${c.agentId}-${c.type}-${c.label}-${c.expiryDate}`}
                    cred={c}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
