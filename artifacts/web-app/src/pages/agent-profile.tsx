import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetAgent,
  useUpdateAgent,
  useOffboardAgent,
  useGetAgentOffboardingReport,
  getGetAgentOffboardingReportQueryKey,
  getGetAgentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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
import { ArrowLeft, Award, CheckSquare, FileText, FolderOpen, Monitor, ShieldCheck, User, FileDown, DollarSign } from "lucide-react";
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
import { STATUS_STYLES } from "./agent-profile/shared";

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
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full" />
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

  return (
    <div className="max-w-5xl mx-auto">
      <div className="p-6 pb-0 space-y-5">
        <Button variant="ghost" size="sm" className="-ml-1 text-muted-foreground" onClick={() => navigate("/agents")}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Agents
        </Button>

        <div className="flex items-start gap-4">
          <Avatar className="h-16 w-16 shrink-0">
            <AvatarImage src={agent.avatarUrl ?? undefined} />
            <AvatarFallback className="text-xl bg-primary/10 text-primary">
              {agent.firstName[0]}{agent.lastName[0]}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3 flex-wrap">
              <div>
                <h1 className="text-xl font-bold">{agent.firstName} {agent.lastName}</h1>
                <p className="text-sm text-muted-foreground">{agent.email}</p>
                {agent.phone && <p className="text-sm text-muted-foreground">{agent.phone}</p>}
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge
                  variant="secondary"
                  className={`capitalize border ${STATUS_STYLES[agent.status] ?? ""}`}
                >
                  {agent.status}
                </Badge>
                {agent.npn && (
                  <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                    NPN {agent.npn}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            {offboardingReport && (
              <Button
                variant="outline"
                size="sm"
                asChild
              >
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
                className="text-destructive border-destructive/30 hover:bg-destructive/5"
                onClick={() => setOffboardConfirm(true)}
              >
                Offboard
              </Button>
            )}
            <Select value={agent.status} onValueChange={handleStatusChange}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["onboarding", "active", "suspended", "offboarding", "offboarded"].map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div>
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
      </div>

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
