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
  useGetMe,
  useGetAgent,
  useGetCarriers,
} from "@workspace/api-client-react";
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
import { ChevronLeft, AlertTriangle, Send } from "lucide-react";
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
  const { data: me } = useGetMe();
  const [, navigate] = useLocation();
  const isAdmin = me && ["super_admin", "agency_admin", "compliance_manager"].includes(me.role);

  const { data: onboarding, isLoading: obLoading } = useOnboarding(agentId, {
    enabled: Boolean(isAdmin),
  });
  const { data: agent } = useGetAgent(agentId);

  const [cancelOpen, setCancelOpen] = useState(false);
  const requestContracting = useRequestContracting(agentId);
  const cancelOnboarding = useCancelOnboarding(agentId);

  if (me && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have access to the admin onboarding dashboard.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (obLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!onboarding) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Link href="/admin-onboarding">
          <Button variant="ghost" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back to dashboard
          </Button>
        </Link>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No active onboarding run for this agent.
          </CardContent>
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
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <Link href="/admin-onboarding">
        <Button variant="ghost" size="sm" data-testid="back-to-dashboard">
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to dashboard
        </Button>
      </Link>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">
            {agent ? `${agent.firstName} ${agent.lastName}` : "Onboarding"}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {agent?.email}
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Badge variant="secondary">{onboardingStatusLabel(run.status)}</Badge>
            {run.poaStatus && run.poaStatus !== "not_applicable" && (
              <Badge
                variant={
                  run.poaStatus === "signed"
                    ? "default"
                    : run.poaStatus === "opted_out"
                      ? "outline"
                      : "secondary"
                }
                data-testid="admin-poa-badge"
              >
                {poaStatusLabel(run.poaStatus)}
              </Badge>
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

        <div className="flex items-center gap-2">
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
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contracting profile</CardTitle>
        </CardHeader>
        <CardContent>
          {!profile ? (
            <p className="text-sm text-muted-foreground italic">
              The agent hasn't started their profile yet.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Row label="SSN" value={profile.ssn} />
              <Row label="EIN" value={profile.ein} />
              <Row label="DOB" value={profile.dob} />
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
            <p className="text-[11px] text-muted-foreground mt-3 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              SSN and EIN are masked — only super admins, agency admins, and
              compliance managers can view the plaintext values.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Carrier contracting requests ({active.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {active.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground italic">
              The agent hasn't selected any carriers yet.
            </p>
          ) : (
            <CarrierRequestsTable requests={active} agentId={agentId} />
          )}
        </CardContent>
      </Card>

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
      <TableHeader>
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
              <Badge variant="outline" className="text-[10px]">
                {contractingStatusLabel(r.status)}
              </Badge>
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

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-xs font-medium break-words">
        {value && String(value).trim().length > 0 ? value : "—"}
      </span>
    </div>
  );
}
