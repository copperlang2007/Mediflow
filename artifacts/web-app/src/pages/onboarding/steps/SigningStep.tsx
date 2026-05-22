import { useMemo } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useGetCarriers, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, PenTool } from "lucide-react";
import {
  type CarrierContractingRequest,
  contractingStatusLabel,
  useStartCarrierSign,
} from "@/lib/onboarding/api";

/**
 * Sign-paperwork step. Each carrier-contracting-request whose paperwork
 * has been generated gets a "Sign now" button — clicking it creates an
 * e-sign envelope via `POST /esign/envelopes` and navigates the agent to
 * `/sign/:envelopeId` (our in-house signing window). On return, React
 * Query's onboarding-detail invalidation surfaces the updated `signed`
 * status.
 */
export function SigningStep({
  agentId,
  carrierRequests,
  onContinue,
}: {
  agentId: string;
  carrierRequests: CarrierContractingRequest[];
  onContinue: () => void;
}) {
  const { data: carriers } = useGetCarriers();
  const { data: me } = useGetMe();
  const [, setLocation] = useLocation();
  const carrierName = useMemo(() => {
    const m = new Map<string, string>();
    (carriers ?? []).forEach((c) => m.set(c.id, c.name));
    return (id: string) => m.get(id) ?? id;
  }, [carriers]);

  const { mutateAsync, isPending } = useStartCarrierSign(agentId);

  const active = carrierRequests.filter((r) => r.status !== "cancelled");
  const ready = active.filter((r) => r.status === "paperwork_generated");
  const signedOrLater = active.filter(
    (r) => r.status !== "draft" && r.status !== "paperwork_generated",
  );
  const allDone = active.length > 0 && ready.length === 0 && active.every((r) => r.status !== "draft");

  const handleSign = async (req: CarrierContractingRequest) => {
    if (!req.paperworkDocumentId) {
      toast.error("This carrier's paperwork isn't ready yet.");
      return;
    }
    if (!me) {
      toast.error("Loading your user profile — try again in a moment.");
      return;
    }
    try {
      const res = await mutateAsync({
        pdfDocumentId: req.paperworkDocumentId,
        carrierContractingRequestId: req.id,
        signers: [
          {
            userId: me.id,
            displayName: me.fullName,
            email: me.email,
          },
        ],
      });
      // Prefer the server-provided signing URL; fall back to convention.
      const target = res.signingUrl || `/sign/${res.envelopeId}`;
      setLocation(target);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start signing",
      );
    }
  };

  if (active.length === 0) {
    return (
      <Card data-testid="signing-step">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No carrier paperwork has been generated yet. An administrator will
          create the packets after reviewing your selections.
        </CardContent>
      </Card>
    );
  }

  const isPaperworkPending = active.some((r) => r.status === "draft");

  return (
    <Card data-testid="signing-step">
      <CardHeader>
        <CardTitle>Sign carrier paperwork</CardTitle>
        <CardDescription>
          Each carrier has its own contracting packet. Click "Sign now" to
          open the in-house signing window (Beta).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPaperworkPending && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
            <Clock className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              Some paperwork is still being prepared by your administrator.
              Refresh this page once they've reviewed your selections.
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {active.map((r) => {
            const canSign = r.status === "paperwork_generated";
            const done = r.status === "signed" || r.status === "submitted" || r.status === "under_review" || r.status === "appointed";
            return (
              <li
                key={r.id}
                className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3 flex-wrap"
                data-testid={`signing-row-${r.carrierId}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {done ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  ) : canSign ? (
                    <PenTool className="h-5 w-5 text-primary shrink-0" />
                  ) : (
                    <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{carrierName(r.carrierId)}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.states.join(", ")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={done ? "secondary" : "outline"} className="text-[10px]">
                    {contractingStatusLabel(r.status)}
                  </Badge>
                  {canSign && (
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleSign(r)}
                      data-testid={`sign-btn-${r.carrierId}`}
                    >
                      {isPending ? "Opening…" : "Sign now"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {signedOrLater.length > 0 && allDone && (
          <div className="flex justify-end pt-2 border-t">
            <Button onClick={onContinue} data-testid="signing-continue">
              All done — view summary
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
