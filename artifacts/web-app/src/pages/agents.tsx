import { useState } from "react";
import { useGetAgents, useCreateAgent, useGetAgentComplianceScore } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Users, Plus, Search, Filter, ChevronRight } from "lucide-react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_STYLES: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-green-100 text-green-800 border-green-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  offboarding: "bg-orange-100 text-orange-800 border-orange-200",
  offboarded: "bg-slate-100 text-slate-600 border-slate-200",
};

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "onboarding", label: "Onboarding" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "offboarding", label: "Offboarding" },
  { value: "offboarded", label: "Offboarded" },
];

function ComplianceBar({ agentId }: { agentId: string }) {
  const { data } = useGetAgentComplianceScore(agentId);
  if (!data) return <div className="w-20 h-1.5 rounded-full bg-muted" />;
  const score = data.totalScore;
  const color =
    score >= 80 ? "bg-green-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {Math.round(score)}
      </span>
    </div>
  );
}

function AddAgentDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { mutateAsync, isPending } = useCreateAgent();
  const [, navigate] = useLocation();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    npn: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName || !form.lastName || !form.email) return;

    try {
      const agent = await mutateAsync({
        data: {
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone || undefined,
          npn: form.npn || undefined,
        },
      });
      toast.success(`Agent ${agent.firstName} ${agent.lastName} created — onboarding checklist started`);
      void qc.invalidateQueries({ queryKey: ["getAgents"] });
      onClose();
      navigate(`/agents/${agent.id}`);
    } catch {
      toast.error("Failed to create agent");
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="firstName">First name *</Label>
              <Input id="firstName" value={form.firstName} onChange={set("firstName")} placeholder="Jane" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last name *</Label>
              <Input id="lastName" value={form.lastName} onChange={set("lastName")} placeholder="Smith" required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email *</Label>
            <Input id="email" type="email" value={form.email} onChange={set("email")} placeholder="jane@agency.com" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={form.phone} onChange={set("phone")} placeholder="(555) 000-0000" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="npn">NPN</Label>
              <Input id="npn" value={form.npn} onChange={set("npn")} placeholder="12345678" />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending || !form.firstName || !form.lastName || !form.email}>
              {isPending ? "Creating…" : "Create Agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [, navigate] = useLocation();

  const { data, isLoading } = useGetAgents({
    search: search || undefined,
    status: status === "all" ? undefined : status,
  });

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your sales agent roster</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Agent
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <Filter className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : (data?.agents ?? []).length === 0 ? (
            <div className="py-16 text-center">
              <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No agents found</p>
              <p className="text-xs text-muted-foreground mt-1">Add your first agent to get started</p>
              <Button className="mt-4" size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Agent
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 px-5 py-2.5 border-b border-border">
                <span className="w-9" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Agent</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:block w-24 text-center">NPN</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24 text-center">Status</span>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-28 text-right">Compliance</span>
              </div>
              <div className="divide-y divide-border">
                {(data?.agents ?? []).map((agent) => (
                  <div
                    key={agent.id}
                    className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors cursor-pointer group"
                    onClick={() => navigate(`/agents/${agent.id}`)}
                  >
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={agent.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs bg-primary/10 text-primary">
                        {agent.firstName[0]}{agent.lastName[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm text-foreground">{agent.firstName} {agent.lastName}</p>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                    </div>
                    <span className="text-xs text-muted-foreground hidden md:block w-24 text-center tabular-nums">
                      {agent.npn ? `NPN ${agent.npn}` : "—"}
                    </span>
                    <div className="w-24 flex justify-center">
                      <Badge
                        variant="secondary"
                        className={`text-xs shrink-0 capitalize border ${STATUS_STYLES[agent.status] ?? ""}`}
                      >
                        {agent.status}
                      </Badge>
                    </div>
                    <div className="w-28 flex justify-end">
                      <ComplianceBar agentId={agent.id} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {data && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {data.agents.length} of {data.total} agents
        </p>
      )}

      <AddAgentDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
