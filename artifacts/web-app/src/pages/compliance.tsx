import { useGetAuditLog } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, Activity, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function CompliancePage() {
  const { data, isLoading } = useGetAuditLog({});

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Audit & Compliance</h1>
        <p className="text-sm text-muted-foreground mt-0.5">HIPAA audit trail and compliance monitoring</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Audit Log
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (data?.entries ?? []).length === 0 ? (
            <div className="py-14 text-center">
              <ShieldCheck className="h-12 w-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">No audit events recorded yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(data?.entries ?? []).map((entry) => (
                <div key={entry.id} className="flex items-start gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors">
                  <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-[11px]">{entry.resourceType}</Badge>
                      <span className="text-sm font-medium">{entry.action}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {entry.userFullName ?? entry.userId ?? "System"}
                      {entry.userRole && ` · ${entry.userRole}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
