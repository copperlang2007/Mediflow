/**
 * Phase 1.5 — POA decision step.
 *
 * The agent picks one of two paths after carrier selection:
 *
 *   - "Yes — INSUREitALL handles it" (recommended). POSTs `accepted: true`
 *     to the backend which generates a placeholder POA PDF and creates an
 *     e-sign envelope. We navigate to `/sign/:envelopeId` (existing native
 *     e-sign window). After the agent signs, the wizard surfaces the
 *     "POA signed" confirmation.
 *
 *   - "No — I'll complete each carrier myself" (opt-out). Triggers a
 *     confirmation dialog because every carrier_contracting_request flips
 *     to `invite_requested` and emails are queued; the path back requires
 *     an admin to cancel + restart the run.
 *
 * The copy makes both options sound first-class — opt-out isn't a
 * "degraded fallback", it's the right choice for some agents.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useGetCarriers } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { CheckCircle2, ShieldCheck, UserSquare } from "lucide-react";
import {
  type CarrierContractingRequest,
  usePoaDecision,
} from "@/lib/onboarding/api";

export function PoaDecisionStep({
  agentId,
  carrierRequests,
  onContinue,
}: {
  agentId: string;
  carrierRequests: CarrierContractingRequest[];
  onContinue: () => void;
}) {
  const { data: carriers } = useGetCarriers();
  const carrierName = useMemo(() => {
    const m = new Map<string, string>();
    (carriers ?? []).forEach((c) => m.set(c.id, c.name));
    return (id: string) => m.get(id) ?? id;
  }, [carriers]);
  const [, setLocation] = useLocation();
  const [confirmOptOut, setConfirmOptOut] = useState(false);
  const decision = usePoaDecision(agentId);

  const active = carrierRequests.filter((r) => r.status !== "cancelled");
  const carrierCount = active.length;

  const handleAccept = async () => {
    try {
      const res = await decision.mutateAsync({ accepted: true });
      if (res.signingUrl) {
        setLocation(res.signingUrl);
      } else {
        // Re-call landing in an already-pending state — go to the existing
        // envelope.
        if (res.envelopeId) {
          setLocation(`/sign/${res.envelopeId}`);
        }
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start POA signing",
      );
    }
  };

  const handleOptOut = async () => {
    setConfirmOptOut(false);
    try {
      await decision.mutateAsync({ accepted: false });
      toast.success(
        "Opted out — carrier invitation emails are on their way.",
      );
      onContinue();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to record decision",
      );
    }
  };

  return (
    <Card data-testid="poa-decision-step">
      <CardHeader>
        <CardTitle>Authorize INSUREitALL to submit your contracts</CardTitle>
        <CardDescription>
          You have two options for finishing your contracting paperwork. Pick
          the one that fits how you'd like to work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            You selected <strong>{carrierCount}</strong> carrier
            {carrierCount === 1 ? "" : "s"}:
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {active.map((r) => (
              <Badge key={r.id} variant="outline" className="text-[10px]">
                {carrierName(r.carrierId)}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div
            className="rounded-lg border bg-card p-4 flex flex-col gap-3"
            data-testid="poa-option-accept"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <p className="text-sm font-semibold">
                Yes — INSUREitALL handles it
              </p>
              <Badge variant="secondary" className="text-[10px]">
                Recommended
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              You sign one Power of Attorney. INSUREitALL submits all
              {` ${carrierCount} `}carrier applications on your behalf. Most
              agents finish in 1–3 weeks per carrier.
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 pl-4 list-disc">
              <li>Sign once, not per carrier</li>
              <li>We handle every appointment-desk follow-up</li>
              <li>POA expires in 90 days; revocable any time</li>
            </ul>
            <Button
              onClick={handleAccept}
              disabled={decision.isPending}
              data-testid="poa-accept-btn"
              className="mt-auto"
            >
              {decision.isPending ? "Opening…" : "Review and sign POA"}
            </Button>
          </div>

          <div
            className="rounded-lg border bg-card p-4 flex flex-col gap-3"
            data-testid="poa-option-decline"
          >
            <div className="flex items-center gap-2">
              <UserSquare className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-semibold">
                No — I'll complete each carrier myself
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Each carrier will email you an invitation link to complete
              their contracting flow directly. You'll do {carrierCount}{" "}
              separate sign-ups instead of one POA.
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 pl-4 list-disc">
              <li>Full control over each carrier's paperwork</li>
              <li>Watch your inbox for {carrierCount} invitations</li>
              <li>Contact INSUREitALL if any don't arrive in 48 hours</li>
            </ul>
            <Button
              variant="outline"
              onClick={() => setConfirmOptOut(true)}
              disabled={decision.isPending}
              data-testid="poa-decline-btn"
              className="mt-auto"
            >
              I'll handle it myself
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 inline mr-1" />
          Either option finishes your onboarding. You can come back to this
          page any time to check progress.
        </p>
      </CardContent>

      <AlertDialog open={confirmOptOut} onOpenChange={setConfirmOptOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Complete each carrier yourself?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You'll receive {carrierCount} separate invitation emails from
              the carriers you selected. To switch back to the POA path
              after this, your admin will need to cancel and restart your
              onboarding. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={decision.isPending}>
              Keep me on the POA path
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleOptOut}
              disabled={decision.isPending}
              data-testid="poa-decline-confirm"
            >
              {decision.isPending ? "Submitting…" : "Yes, I'll handle it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
