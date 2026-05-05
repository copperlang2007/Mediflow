import { useState } from "react";
import { useGetAgents } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Users, Plus, Search, Filter } from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  suspended: "bg-red-100 text-red-800",
  offboarding: "bg-orange-100 text-orange-800",
  offboarded: "bg-slate-100 text-slate-600",
};

export default function AgentsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useGetAgents({ search: search || undefined });

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your sales agent roster</p>
        </div>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Add Agent
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="icon">
          <Filter className="h-4 w-4" />
        </Button>
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
              <Button className="mt-4" size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Agent
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(data?.agents ?? []).map((agent) => (
                <div key={agent.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors cursor-pointer">
                  <Avatar className="h-9 w-9 shrink-0">
                    <AvatarImage src={agent.avatarUrl ?? undefined} />
                    <AvatarFallback className="text-xs bg-primary/10 text-primary">
                      {agent.firstName[0]}{agent.lastName[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-foreground">{agent.firstName} {agent.lastName}</p>
                    <p className="text-xs text-muted-foreground">{agent.email}</p>
                  </div>
                  {agent.npn && (
                    <span className="text-xs text-muted-foreground hidden md:block">NPN: {agent.npn}</span>
                  )}
                  <Badge variant="secondary" className={`text-xs shrink-0 ${STATUS_STYLES[agent.status] ?? ""}`}>
                    {agent.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {data.agents.length} of {data.total} agents
        </p>
      )}
    </div>
  );
}
