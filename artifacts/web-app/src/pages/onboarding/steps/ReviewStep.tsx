import { useMemo } from "react";
import { SensitiveValue, type SensitiveKind } from "@/components/shared";
import { useGetCarriers } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  type AgentContractingProfile,
  type CarrierContractingRequest,
} from "@/lib/onboarding/api";

export function ReviewStep({
  profile,
  carrierRequests,
  onBack,
  onContinue,
}: {
  agentId: string;
  profile: AgentContractingProfile | null;
  carrierRequests: CarrierContractingRequest[];
  onBack: () => void;
  onContinue: () => void;
}) {
  const { data: carriers } = useGetCarriers();
  const carrierName = useMemo(() => {
    const m = new Map<string, string>();
    (carriers ?? []).forEach((c) => m.set(c.id, c.name));
    return (id: string) => m.get(id) ?? id;
  }, [carriers]);

  const active = carrierRequests.filter((r) => r.status !== "cancelled");

  return (
    <Card data-testid="review-step">
      <CardHeader>
        <CardTitle>Review your selections</CardTitle>
        <CardDescription>
          Double-check everything before submitting to your administrator for
          paperwork generation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <h3 className="text-sm font-semibold mb-2">Profile</h3>
          <div className="rounded-lg border bg-muted/30 p-3 grid sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <Row label="SSN" value={profile?.ssn} sensitive="ssn" />
            <Row label="Date of birth" value={profile?.dob} sensitive="dob" />
            <Row label="Phone" value={profile?.phone} />
            <Row label="Email" value={profile?.email} />
            <Row
              label="Home address"
              value={[
                profile?.homeAddressLine1,
                profile?.homeAddressLine2,
                [profile?.homeCity, profile?.homeState, profile?.homeZip]
                  .filter(Boolean)
                  .join(", "),
              ]
                .filter((v) => v && String(v).trim().length > 0)
                .join(" · ")}
              wide
            />
            <Row label="Entity" value={profile?.entityType ?? "individual"} />
            {profile?.businessName && <Row label="Business" value={profile.businessName} />}
            {profile?.ein && <Row label="EIN" value={profile.ein} sensitive="ein" />}
            <Row label="E&O carrier" value={profile?.eAndOCarrier} />
            <Row label="E&O policy" value={profile?.eAndOPolicyNumber} />
            <Row label="E&O expires" value={profile?.eAndOExpiresOn} />
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2">
            Carrier selections ({active.length})
          </h3>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No carriers selected. Go back to the previous step to pick at
              least one carrier.
            </p>
          ) : (
            <ul className="space-y-2">
              {active.map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border bg-card p-3"
                  data-testid={`review-carrier-${r.carrierId}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-sm font-medium">
                      {carrierName(r.carrierId)}
                    </p>
                    <Badge variant="outline" className="text-[10px]">
                      {r.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {r.states.map((s) => (
                      <span
                        key={s}
                        className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Once you submit, your administrator will be notified and will
          generate the contracting paperwork. You'll be brought back here to
          sign each carrier's packet when it's ready.
        </div>

        <div className="flex justify-between gap-2 border-t pt-4">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onContinue} data-testid="review-continue">
            Submit for admin review
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  wide,
  sensitive,
}: {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
  /** SSN / EIN / DOB: masked to the last 4 with a Reveal button. */
  sensitive?: SensitiveKind;
}) {
  return (
    <div
      className={wide ? "sm:col-span-2 grid grid-cols-[120px_1fr] gap-2" : "grid grid-cols-[120px_1fr] gap-2"}
    >
      <span className="text-muted-foreground text-xs">{label}</span>
      {sensitive ? (
        <SensitiveValue kind={sensitive} label={label} value={value} className="text-xs font-medium" />
      ) : (
        <span className="text-xs font-medium break-words">
          {value && String(value).trim().length > 0 ? value : "—"}
        </span>
      )}
    </div>
  );
}
