import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Download, Link2, ListTree } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, SectionCard, StatusPill } from "@/components/shared";
import { downloadCsvText } from "@/lib/exports";

type GhlStatus = {
  configured: boolean;
  locationId: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRun: { created: number; updated: number; skipped: number; failed: number } | null;
};

type GhlCustomField = { id: string; name: string; fieldKey: string | null; dataType: string | null };

function errorText(err: unknown): string {
  // customFetch throws an ApiError carrying the parsed body on `data`.
  const message = (err as { data?: { error?: unknown } } | null)?.data?.error;
  if (typeof message === "string" && message) return message;
  return "Couldn't load this from GoHighLevel. Please retry.";
}

/**
 * GoHighLevel connection for agency admins: whether the contact feed is
 * connected, how its last run went, and the sub-account's custom field
 * definitions (names and types only) so fields like Sunfire plan data can be
 * mapped. No contact data is shown here.
 */
export function GhlConnectionCard() {
  const status = useQuery({
    queryKey: ["/api/integrations/ghl/status"],
    queryFn: () => customFetch<GhlStatus>("/api/integrations/ghl/status"),
  });
  const configured = status.data?.configured === true;
  const fields = useQuery({
    queryKey: ["/api/integrations/ghl/custom-fields"],
    queryFn: () => customFetch<{ locationId: string; fields: GhlCustomField[] }>("/api/integrations/ghl/custom-fields"),
    enabled: configured,
    retry: false,
  });

  const download = () => {
    if (!fields.data) return;
    downloadCsvText(
      [["Field name", "Merge key", "Type", "Field id"], ...fields.data.fields.map((f) => [f.name, f.fieldKey ?? "", f.dataType ?? "", f.id])],
      "gohighlevel-custom-fields.csv",
    );
  };

  return (
    <SectionCard
      title="GoHighLevel connection"
      icon={Link2}
      description="Clients from your GoHighLevel account flow into agencyBRIDGE automatically. Below are the custom fields that account defines, which we map to Medicare IDs, carriers and plans."
    >
      {status.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : status.isError ? (
        <p className="text-sm text-muted-foreground">{errorText(status.error)}</p>
      ) : !configured ? (
        <EmptyState
          compact
          icon={Link2}
          title="Not connected"
          description="Add the GoHighLevel sub-account's Private Integration token and location id, and switch the feed on for this agency."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusPill status={status.data?.lastStatus ?? "pending"} />
            <span className="text-muted-foreground">
              Location <code className="font-mono text-xs">{status.data?.locationId}</code>
            </span>
            {status.data?.lastRunAt && (
              <span className="text-xs text-muted-foreground">
                Last sync {formatDistanceToNow(new Date(status.data.lastRunAt), { addSuffix: true })}
                {status.data.lastRun
                  ? ` · ${status.data.lastRun.created} added · ${status.data.lastRun.updated} updated${status.data.lastRun.failed ? ` · ${status.data.lastRun.failed} failed` : ""}`
                  : ""}
              </span>
            )}
          </div>
          {status.data?.lastError && <p className="text-xs text-destructive">{status.data.lastError}</p>}

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ListTree className="h-4 w-4 text-accent" />
              <p className="text-sm font-medium">
                Custom fields{fields.data ? ` (${fields.data.fields.length})` : ""}
              </p>
              {fields.data && fields.data.fields.length > 0 && (
                <Button variant="outline" size="sm" className="ml-auto" onClick={download}>
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Download list
                </Button>
              )}
            </div>
            {fields.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : fields.isError ? (
              <p className="text-sm text-muted-foreground">{errorText(fields.error)}</p>
            ) : !fields.data || fields.data.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">This GoHighLevel account has no contact custom fields.</p>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Field name</th>
                      <th className="py-1.5 pr-3 font-medium">Merge key</th>
                      <th className="py-1.5 font-medium">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {fields.data.fields.map((f) => (
                      <tr key={f.id}>
                        <td className="py-1.5 pr-3">{f.name}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground break-all">{f.fieldKey ?? "—"}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{f.dataType ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
