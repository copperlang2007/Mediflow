import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetAgent,
  useGetAgentComplianceScore,
  useUpdateAgent,
  useOffboardAgent,
  useGetAgentOffboardingReport,
  getGetAgentOffboardingReportQueryKey,
  getGetAgentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ArrowLeft, Award, CheckSquare, FileText, FolderOpen, Monitor, ShieldCheck, User, FileDown, DollarSign, Mail, Phone } from "lucide-react";
import { StatusPill, humanizeStatus } from "@/components/shared";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import OverviewTab from "./agent-profile/OverviewTab";
import LicensesTab from "./agent-profile/LicensesTab";
import CertificationsTab from "./agent-profile/CertificationsTab";
import AhipTab from "./agent-profile/AhipTab";
import ChecklistTab from "./agent-profile/ChecklistTab";
import TechStackTab from "./agent-profile/TechStackTab";
import TasksTab from "./agent-profile/TasksTab";
import DocumentsTab from "./agent-profile/DocumentsTab";
import ActivityTab from "./agent-profile/ActivityTab";
import CommissionsTab from "./agent-profile/CommissionsTab";

type Tab = "overview" | "licenses" | "certifications" | "ahip" | "checklist" | "techstack" | "tasks" | "documents" | "activity" | "commissions";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: User },
  { id: "licenses", label: "Licenses", icon: FileText },
  { id: "certifications", label: "Certifications", icon: Award },
  { id: "ahip", label: "AHIP", icon: ShieldCheck },
  { id: "checklist", label: "Checklist", icon: CheckSquare },
  { id: "techstack", label: "Tech Stack", icon: Monitor },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "documents", label: "Documents", icon: FolderOpen },
  { id: "activity", label: "Activity", icon: FileText },
  { id: "commissions", label: "Commissions", icon: DollarSign },
];

export default function AgentProfilePage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [offboardConfirm, setOffboardConfirm] = useState(false);

  const { data: agent, isLoading } = useGetAgent(agentId);
  const { data: score } = useGetAgentComplianceScore(agentId);
  const { mutateAsync: updateAgent } = useUpdateAgent();
  const { mutateAsync: offboard, isPending: offboarding } = useOffboardAgent();
  // The report only exists once offboarding has run (the worker files it as
  // an "offboarding" document), and the endpoint 404s until then. Only ask
  // for it on agents that are offboarding/offboarded, and treat a 404 as
  // "not generated yet" rather than retrying.
  const offboardingStarted = agent?.status === "offboarding" || agent?.status === "offboarded";
  const { data: offboardingReport } = useGetAgentOffboardingReport(agentId, {
    query: {
      enabled: !!agentId && offboardingStarted,
      retry: false,
      queryKey: getGetAgentOffboardingReportQueryKey(agentId),
    },
  });

  const handleOffboard = async () => {
    try {
      await offboard({ id: agentId });
      toast.success("Offboarding initiated — checklist created");
      void qc.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
      setOffboardConfirm(false);
    } catch { toast.error("Failed to start offboarding"); }
  };

  const handleStatusChange = async (newStatus: string) => {
    try {
      await updateAgent({ id: agentId, data: { status: newStatus as "onboarding" | "active" | "suspended" | "offboarding" | "offboarded" } });
      void qc.invalidateQueries({ queryKey: getGetAgentQueryKey(agentId) });
      toast.success("Status updated");
    } catch { toast.error("Failed to update status"); }
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 space-y-4 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-44 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Agent not found</p>
        <Button variant="link" onClick={() => navigate("/agents")}>Back to Agents</Button>
      </div>
    );
  }

  const totalScore = score ? Math.round(score.totalScore) : null;
  const stats: Array<{ label: string; value: string; tone?: string }> = [
    {
      label: "Active licenses",
      value: agent.activeLicensesCount != null
        ? `${agent.activeLicensesCount}${agent.licensesCount != null ? ` of ${agent.licensesCount}` : ""}`
        : "—",
    },
    {
      label: "Certifications",
      value: agent.activeCertificationsCount != null
        ? `${agent.activeCertificationsCount}${agent.certificationsCount != null ? ` of ${agent.certificationsCount}` : ""}`
        : "—",
    },
    {
      label: "Compliance score",
      value: totalScore != null ? `${totalScore}%` : "—",
      tone: totalScore == null ? undefined : totalScore >= 80 ? "text-success" : totalScore >= 50 ? "text-warning" : "text-destructive",
    },
    {
      label: "Hire date",
      value: agent.hireDate ? new Date(agent.hireDate).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—",
    },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate("/agents")}>
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        Back to Agents
      </Button>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Navy banner, as on the agencyBRIDGE agent page */}
        <div
          className="flex flex-col gap-4 px-5 py-5 text-white sm:px-6 lg:flex-row lg:items-center"
          style={{ backgroundImage: "linear-gradient(135deg, var(--kpi-navy-from), var(--kpi-navy-to))" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <Avatar className="h-16 w-16 shrink-0 ring-2 ring-white/25">
              <AvatarImage src={agent.avatarUrl ?? undefined} />
              <AvatarFallback className="bg-white/15 text-xl font-semibold text-white">
                {agent.firstName[0]}{agent.lastName[0]}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold tracking-tight">{agent.firstName} {agent.lastName}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/80">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Mail className="h-4 w-4 shrink-0" /><span className="truncate">{agent.email}</span>
                </span>
                {agent.phone && (
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Phone className="h-4 w-4" />{agent.phone}</span>
                )}
                {agent.npn && <span className="whitespace-nowrap font-mono text-xs">NPN {agent.npn}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={agent.status} className="bg-white/15 border-white/25 text-white" />
            {agent.ahipCurrentYear && (
              <StatusPill tone="neutral" className="bg-white/15 border-white/25 text-white">AHIP {agent.ahipCurrentYear}</StatusPill>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 px-5 py-4 sm:px-6 lg:grid-cols-4">
          {stats.map((st) => (
            <div key={st.label}>
              <p className="text-xs text-muted-foreground">{st.label}</p>
              <p className={cn("font-display text-2xl font-bold", st.tone)}>{st.value}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 sm:px-6">
          <span className="text-sm text-muted-foreground mr-1">Status</span>
          <Select value={agent.status} onValueChange={handleStatusChange}>
            <SelectTrigger className="h-8 text-sm w-40" aria-label="Change status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["onboarding", "active", "suspended", "offboarding", "offboarded"].map((st) => (
                <SelectItem key={st} value={st}>{humanizeStatus(st)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          {offboardingReport && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/agents/${agentId}/offboarding-report/download`}
                target="_blank"
                rel="noreferrer"
              >
                <FileDown className="h-3.5 w-3.5 mr-1.5" />
                Offboarding Report
              </a>
            </Button>
          )}
          {agent.status !== "offboarded" && agent.status !== "offboarding" && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
              onClick={() => setOffboardConfirm(true)}
            >
              Offboard
            </Button>
          )}
        </div>
      </section>

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm" role="tablist" aria-label="Agent sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              activeTab === tab.id
                ? "bg-muted text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <section className="rounded-xl border border-border bg-card shadow-sm">
        {activeTab === "overview" && <OverviewTab agentId={agentId} />}
        {activeTab === "licenses" && <LicensesTab agentId={agentId} />}
        {activeTab === "certifications" && <CertificationsTab agentId={agentId} />}
        {activeTab === "ahip" && <AhipTab agentId={agentId} />}
        {activeTab === "checklist" && <ChecklistTab agentId={agentId} />}
        {activeTab === "techstack" && <TechStackTab agentId={agentId} />}
        {activeTab === "tasks" && <TasksTab agentId={agentId} />}
        {activeTab === "documents" && <DocumentsTab agentId={agentId} />}
        {activeTab === "activity" && <ActivityTab agentId={agentId} />}
        {activeTab === "commissions" && <CommissionsTab agentId={agentId} />}
      </section>

      <AlertDialog open={offboardConfirm} onOpenChange={setOffboardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Offboard {agent.firstName} {agent.lastName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will set the agent status to Offboarding and automatically create an offboarding checklist. This action can be reviewed and reversed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleOffboard}
              disabled={offboarding}
            >
              {offboarding ? "Starting…" : "Start Offboarding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
