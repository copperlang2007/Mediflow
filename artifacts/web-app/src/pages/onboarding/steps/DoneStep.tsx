import { useMemo } from "react";
import { useGetCarriers } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, PartyPopper } from "lucide-react";
import {
  type AgentOnboardingRun,
  type CarrierContractingRequest,
  contractingStatusLabel,
  onboardingStatusLabel,
} from "@/lib/onboarding/api";

export function DoneStep({
  run,
  carrierRequests,
}: {
  run: AgentOnboardingRun;
  carrierRequests: CarrierContractingRequest[];
}) {
  const { data: carriers } = useGetCarriers();
  const carrierName = useMemo(() => {
    const m = new Map<string, string>();
    (carriers ?? []).forEach((c) => m.set(c.id, c.name));
    return (id: string) => m.get(id) ?? id;
  }, [carriers]);

  const isFullyComplete = run.status === "complete";

  return (
    <Card data-testid="done-step">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5 text-primary" />
          {isFullyComplete ? "You're fully appointed!" : "Submitted to carriers"}
        </CardTitle>
        <CardDescription>
          {isFullyComplete
            ? "All your carrier appointments have been recorded. Welcome aboard!"
            : "Your paperwork has been submitted. We'll keep this page updated as each carrier confirms your appointment."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-3 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Onboarding status</span>
          <Badge variant="secondary">{onboardingStatusLabel(run.status)}</Badge>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Carrier status</h3>
          <ul className="space-y-2">
            {carrierRequests.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3 flex-wrap"
                data-testid={`done-row-${r.carrierId}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {r.status === "appointed" && (
                    <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{carrierName(r.carrierId)}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.states.join(", ")}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <Badge
                    variant={r.status === "appointed" ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {contractingStatusLabel(r.status)}
                  </Badge>
                  {r.writingNumber && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Writing #: {r.writingNumber}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          You can come back to this page any time to check on the status of
          your appointments.
        </p>
      </CardContent>
    </Card>
  );
}
