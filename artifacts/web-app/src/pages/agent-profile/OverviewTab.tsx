import { useGetAgentComplianceScore } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export default function OverviewTab({ agentId }: { agentId: string }) {
  const { data: score } = useGetAgentComplianceScore(agentId);
  if (!score) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  const items = [
    { label: "License Score", value: score.licenseScore, detail: `${score.activeLicenses}/${score.totalLicenses} active` },
    { label: "Cert Score", value: score.certificationScore, detail: `${score.activeCertifications}/${score.totalCertifications} passed` },
    { label: "AHIP Score", value: score.ahipScore, detail: score.ahipCompleted ? "Completed" : "Not completed" },
    { label: "Onboarding Score", value: score.onboardingScore, detail: score.onboardingComplete ? "Complete" : "In progress" },
  ];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold">Overall Compliance Score</p>
          <span className={cn(
            "text-2xl font-bold tabular-nums",
            score.totalScore >= 80 ? "text-green-600" : score.totalScore >= 50 ? "text-amber-600" : "text-red-600"
          )}>
            {Math.round(score.totalScore)}%
          </span>
        </div>
        <Progress
          value={score.totalScore}
          className="h-2"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-lg border border-border p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <span className={cn(
                "text-sm font-bold tabular-nums",
                item.value >= 80 ? "text-green-600" : item.value >= 50 ? "text-amber-600" : "text-red-600"
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
