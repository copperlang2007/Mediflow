/**
 * Admin onboarding detail view.
 *
 * Shows a single agent's onboarding run with their contracting profile and
 * carrier requests. Provides:
 *   - "Request contracting" big-button when in `carriers_selected`
 *   - Per-carrier "Enter writing number" inline form (Day-6 stub)
 *   - "Cancel onboarding" with confirmation dialog
 *
 * The activity timeline section is omitted — `GET /audit` exists but does
 * not yet filter by `resourceType,resourceId` in a way that's safe to expose
 * here (see TODO).
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  useGetAgent,
  useGetCarriers,
} from "@workspace/api-client-react";
import { useIsAdmin, ADMIN_OR_COMPLIANCE_ROLES } from "@/lib/auth/useIsAdmin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, AlertTriangle, Send, Lock, Handshake, Check, UserRound, Building2 } from "lucide-react";
import { EmptyState, SectionCard, StatusPill, SensitiveValue, type SensitiveKind } from "@/components/shared";
import { ContactAvatar } from "@/pages/crm/ui";
import { cn } from "@/lib/utils";

/** The happy path of a contracting run, in order, with plain-language names. */
const RUN_STEPS: Array<{ status: string; label: string }> = [
  { status: "profile_in_progress", label: "Agent profile" },
  { status: "carriers_selected", label: "Carriers picked" },
  { status: "signing", label: "Signing" },
  { status: "submitted", label: "Sent to carriers" },
  { status: "complete", label: "Complete" },
];

function RunProgress({ status }: { status: string }) {
  const idx = status === "draft" ? -1 : RUN_STEPS.findIndex((st) => st.status === status);
  if (idx < 0 && status !== "draft") return null; // cancelled / rejected: the status pill says it
  return (
    <ol className="grid grid-cols-5 gap-2" aria-label="Contracting progress">
      {RUN_STEPS.map((st, i) => {
        const done = i < idx || status === "complete";
        const current = i === idx && status !== "complete";
        return (
          <li key={st.status} className="min-w-0">
            <div className={cn("h-1.5 rounded-full", done ? "bg-success" : current ? "bg-accent" : "bg-muted")} />
            <p className={cn(
              "mt-1.5 flex items-center gap-1 text-xs truncate",
              done ? "text-success" : current ? "font-semibold text-foreground" : "text-muted-foreground",
            )}>
              {done && <Check className="h-3 w-3 shrink-0" />}
              {st.label}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
import {
  contractingStatusLabel,
  onboardingStatusLabel,
  poaStatusLabel,
  useCancelOnboarding,
  useOnboarding,
  useRecordWritingNumber,
  useRequestContracting,
  type AgentOnboardingRun,
  type CarrierContractingRequest,
} from "@/lib/onboarding/api";

export default function AdminOnboardingDetail({ agentId }: { agentId: string }) {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES);
  const [, navigate] = useLocation();

  const { data: onboarding, isLoading: obLoading } = useOnboarding(agentId, {
    enabled: Boolean(isAdmin),
  });
  const { data: agent } = useGetAgent(agentId);

  const [cancelOpen, setCancelOpen] = useState(false);
  const requestContracting = useRequestContracting(agentId);
  const cancelOnboarding = useCancelOnboarding(agentId);

  if (!meLoading && !isAdmin) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <Card>
          <EmptyState
            icon={Lock}
            title="Contracting is for admins"
            description="You don't have access to the contracting dashboard. Ask an agency admin or compliance manager if you need it."
          />
        </Card>
      </div>
    );
  }

  if (obLoading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (!onboarding) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-4">
        <Link href="/admin-onboarding">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back to Contracting
          </Button>
        </Link>
        <Card>
          <EmptyState
            icon={Handshake}
            title="No contracting in progress"
            description="This agent doesn't have an active onboarding run. Start one from the Contracting page."
            action={{ label: "Go to Contracting", href: "/admin-onboarding" }}
          />
        </Card>
      </div>
    );
  }

  const { run, profile, carrierRequests } = onboarding;
  const active = carrierRequests.filter((r) => r.status !== "cancelled");
  // Phase 1.5: per-carrier paperwork generation is deprecated for new runs.
  // The button stays available ONLY for legacy runs (poa_status =
  // not_applicable) that pre-date the pivot.
  const canRequestContracting =
    run.status === "carriers_selected" &&
    (!run.poaStatus || run.poaStatus === "not_applicable");
  const canCancel = !["complete", "cancelled"].includes(run.status);

  const handleRequestContracting = async () => {
    try {
      const result = await requestContracting.mutateAsync();
      toast.success(
        `Generated paperwork for ${result.paperworkGenerated} carrier${result.paperworkGenerated === 1 ? "" : "s"}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to request contracting");
    }
  };

  const handleCancel = async () => {
    try {
      await cancelOnboarding.mutateAsync();
      toast.success("Onboarding cancelled");
      navigate("/admin-onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel");
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <Link href="/admin-onboarding">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" data-testid="back-to-dashboard">
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Contracting
        </Button>
      </Link>

      <header className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <ContactAvatar first={agent?.firstName} last={agent?.lastName} size="lg" />
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold tracking-tight">
                {agent ? `${agent.firstName} ${agent.lastName}` : "Onboarding"}
              </h1>
              {agent?.email && <p className="text-sm text-muted-foreground truncate">{agent.email}</p>}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <StatusPill status={run.status} tone={run.status === "carriers_selected" ? "warning" : run.status === "signing" ? "navy" : undefined}>
                  {onboardingStatusLabel(run.status)}
                </StatusPill>
                {run.poaStatus && run.poaStatus !== "not_applicable" && (
                  <span data-testid="admin-poa-badge">
                    <StatusPill tone={run.poaStatus === "signed" ? "success" : run.poaStatus === "opted_out" ? "neutral" : "warning"}>
                      {poaStatusLabel(run.poaStatus)}
                    </StatusPill>
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  Started {new Date(run.startedAt).toLocaleDateString()}
                </span>
                {run.completedAt && (
                  <span className="text-xs text-muted-foreground">
                    · Completed {new Date(run.completedAt).toLocaleDateString()}
                  </span>
                )}
                {run.poaExpiresAt && run.poaStatus === "signed" && (
                  <span className="text-xs text-muted-foreground">
                    · POA expires {new Date(run.poaExpiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canCancel && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelOpen(true)}
                data-testid="cancel-onboarding-btn"
              >
                Cancel onboarding
              </Button>
            )}
            {canRequestContracting && (
              <Button
                onClick={handleRequestContracting}
                disabled={requestContracting.isPending}
                data-testid="request-contracting-btn"
              >
                <Send className="h-4 w-4 mr-2" />
                {requestContracting.isPending
                  ? "Generating paperwork…"
                  : "Review and request contracting"}
              </Button>
            )}
          </div>
        </div>
        <div className="border-t border-border px-5 py-4 sm:px-6">
          <RunProgress status={run.status} />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-5">
      <SectionCard title="Contracting profile" icon={UserRound} className="lg:col-span-2 self-start">
          {!profile ? (
            <EmptyState compact icon={UserRound} title="Profile not started" description="The agent hasn't started their contracting profile yet." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <SensitiveRow kind="ssn" label="SSN" value={profile.ssn} />
              <SensitiveRow kind="ein" label="EIN" value={profile.ein} />
              <SensitiveRow kind="dob" label="DOB" value={profile.dob} />
              <Row label="Phone" value={profile.phone} />
              <Row label="Email" value={profile.email} />
              <Row label="Entity" value={profile.entityType} />
              {profile.businessName && (
                <Row label="Business" value={profile.businessName} />
              )}
              <Row
                label="Home"
                value={[
                  profile.homeAddressLine1,
                  profile.homeCity && `${profile.homeCity}, ${profile.homeState ?? ""} ${profile.homeZip ?? ""}`,
                ]
                  .filter((v) => v && String(v).trim().length > 0)
                  .join(" · ")}
              />
              <Row label="E&O carrier" value={profile.eAndOCarrier} />
              <Row label="E&O policy" value={profile.eAndOPolicyNumber} />
              <Row label="E&O expires" value={profile.eAndOExpiresOn} />
            </div>
          )}
          {profile && (profile.ssn === null || profile.ssn === "***-**-****") && (
            <p className="text-xs text-muted-foreground mt-4 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              SSN, EIN and date of birth are hidden — only super admins, agency
              admins, and compliance managers can view them.
            </p>
          )}
      </SectionCard>

      <SectionCard
        title={`Carrier requests (${active.length})`}
        description="One row per carrier the agent asked to be contracted with"
        icon={Building2}
        className="lg:col-span-3 self-start"
        contentClassName="px-0 pb-0"
      >
          {active.length === 0 ? (
            <EmptyState compact icon={Building2} title="No carriers picked yet" description="Once the agent chooses the carriers they want to sell for, each request shows up here." />
          ) : (
            <div className="border-t border-border overflow-x-auto">
              <CarrierRequestsTable requests={active} agentId={agentId} />
            </div>
          )}
      </SectionCard>
      </div>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this onboarding?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the onboarding as cancelled. The agent will need
              to start over if they want to be appointed with these carriers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep onboarding</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              data-testid="cancel-confirm"
            >
              Cancel onboarding
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* TODO(audit-timeline): wire `GET /audit?resourceType=agent_onboarding,carrier_contracting&resourceId={id}`
          here once the audit list endpoint supports compound resource-type filtering. */}
    </div>
  );
}

function CarrierRequestsTable({
  requests,
  agentId,
}: {
  requests: CarrierContractingRequest[];
  agentId: string;
}) {
  const { data: carriers } = useGetCarriers();
  const carrierName = (id: string) =>
    (carriers ?? []).find((c) => c.id === id)?.name ?? id;

  return (
    <Table>
      <TableHeader className="bg-muted/50">
        <TableRow>
          <TableHead>Carrier</TableHead>
          <TableHead>States</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Writing #</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((r) => (
          <TableRow key={r.id} data-testid={`admin-carrier-row-${r.id}`}>
            <TableCell className="font-medium text-sm">
              {carrierName(r.carrierId)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1 max-w-xs">
                {r.states.map((s) => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-muted">
                    {s}
                  </span>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <StatusPill status={r.status}>{contractingStatusLabel(r.status)}</StatusPill>
            </TableCell>
            <TableCell>
              <AdminActionCell request={r} agentId={agentId} />
            </TableCell>
            <TableCell>
              <WritingNumberCell request={r} agentId={agentId} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Phase 1.5 — per-request action affordance.
 *
 *   - `awaiting_admin_submission` → "Mark submitted" button (admin submitted
 *     the packet off-system).
 *   - `invite_requested`           → "Mark submitted" button (the agent has
 *     confirmed they completed the carrier's web flow), plus a small
 *     "Resend invite" affordance hint.
 *   - any other state → small status badge text only.
 */
function AdminActionCell({
  request,
  agentId,
}: {
  request: CarrierContractingRequest;
  agentId: string;
}) {
  const recordWritingNumber = useRecordWritingNumber(agentId);
  const canMarkSubmitted =
    request.status === "awaiting_admin_submission" ||
    request.status === "invite_requested";

  if (!canMarkSubmitted) {
    if (request.paperworkDocumentId) {
      return (
        <span className="text-xs text-muted-foreground">Paperwork ready</span>
      );
    }
    return <span className="text-xs text-muted-foreground/60">—</span>;
  }

  const handleMarkSubmitted = async () => {
    try {
      await recordWritingNumber.mutateAsync({
        requestId: request.id,
        status: "submitted",
      });
      toast.success("Marked as submitted");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to mark submitted",
      );
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      onClick={() => {
        void handleMarkSubmitted();
      }}
      disabled={recordWritingNumber.isPending}
      data-testid={`mark-submitted-${request.id}`}
    >
      <Send className="h-3 w-3 mr-1" />
      Mark submitted
    </Button>
  );
}

/**
 * Inline writing-number entry.
 *
 * Wired to `PATCH /admin/contracting/:requestId`. Saving the writing
 * number (without an explicit status) transitions the request to
 * `appointed`; when it's the last outstanding request the backend rolls
 * the onboarding run to `complete` and the page-header badge updates
 * naturally via the react-query refetch triggered on success.
 */
export function WritingNumberCell({
  request,
  agentId,
}: {
  request: CarrierContractingRequest;
  agentId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(request.writingNumber ?? "");
  const recordWritingNumber = useRecordWritingNumber(agentId);
  // Phase 1.5: writing-number entry stays gated on submitted+. Awaiting/invite
  // states aren't appointment-eligible yet — admins flip them to submitted
  // via the action cell first.
  const isReadyForWritingNumber =
    request.status === "submitted" ||
    request.status === "under_review" ||
    request.status === "appointed";

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Writing number is required");
      return;
    }
    try {
      await recordWritingNumber.mutateAsync({
        requestId: request.id,
        writingNumber: trimmed,
      });
      toast.success("Writing number recorded — appointment marked complete");
      setEditing(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save writing number",
      );
    }
  };

  if (request.writingNumber && !editing) {
    return (
      <button
        type="button"
        className="text-xs font-medium text-foreground hover:underline"
        onClick={() => setEditing(true)}
      >
        {request.writingNumber}
      </button>
    );
  }
  if (!isReadyForWritingNumber) {
    return <span className="text-xs text-muted-foreground/60">—</span>;
  }
  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="text-xs h-7"
        onClick={() => setEditing(true)}
        data-testid={`add-writing-num-${request.id}`}
      >
        Enter writing #
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. W-1234567"
        className="h-7 text-xs w-32"
        autoFocus
        disabled={recordWritingNumber.isPending}
      />
      <Button
        size="sm"
        className="h-7 text-xs"
        onClick={() => {
          void handleSave();
        }}
        disabled={recordWritingNumber.isPending}
        data-testid={`save-writing-num-${request.id}`}
      >
        {recordWritingNumber.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs"
        onClick={() => {
          setEditing(false);
          setValue(request.writingNumber ?? "");
        }}
        disabled={recordWritingNumber.isPending}
      >
        Cancel
      </Button>
    </div>
  );
}

function SensitiveRow({ kind, label, value }: { kind: SensitiveKind; label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <span className="block text-muted-foreground text-xs">{label}</span>
      <SensitiveValue kind={kind} label={label} value={value} className="text-sm font-medium" />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <span className="block text-muted-foreground text-xs">{label}</span>
      <span className="block text-sm font-medium [overflow-wrap:anywhere]">
        {value && String(value).trim().length > 0 ? value : "—"}
      </span>
    </div>
  );
}
