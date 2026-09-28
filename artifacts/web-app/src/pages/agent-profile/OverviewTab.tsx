import { useGetAgentComplianceScore } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export default function OverviewTab({ agentId }: { agentId: string }) {
  const { data: score } = useGetAgentComplianceScore(agentId);
  if (!score) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  const items = [
    { label: "Licenses", value: score.licenseScore, detail: `${score.activeLicenses}/${score.totalLicenses} active` },
    { label: "Certifications", value: score.certificationScore, detail: `${score.activeCertifications}/${score.totalCertifications} passed` },
    { label: "AHIP", value: score.ahipScore, detail: score.ahipCompleted ? "Completed" : "Not completed" },
    { label: "Onboarding", value: score.onboardingScore, detail: score.onboardingComplete ? "Complete" : "In progress" },
  ];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div><p className="font-display text-lg font-semibold">Overall compliance score</p><p className="text-sm text-muted-foreground">Licenses, certifications, AHIP and onboarding together</p></div>
          <span className={cn(
            "font-display text-3xl font-bold tabular-nums",
            score.totalScore >= 80 ? "text-success" : score.totalScore >= 50 ? "text-warning" : "text-destructive"
          )}>
            {Math.round(score.totalScore)}%
          </span>
        </div>
        <Progress
          value={score.totalScore}
          className="h-2"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl border border-border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <span className={cn(
                "text-sm font-bold tabular-nums",
                item.value >= 80 ? "text-success" : item.value >= 50 ? "text-warning" : "text-destructive"
              )}>
                {Math.round(item.value)}%
              </span>
            </div>
            <Progress value={item.value} className="h-1" />
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
