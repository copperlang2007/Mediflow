import { useGetAgentDocuments } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, FolderOpen } from "lucide-react";
import { format } from "date-fns";
import { EmptyState } from "@/components/shared";

export default function DocumentsTab({ agentId }: { agentId: string }) {
  const { data: docs, isLoading } = useGetAgentDocuments(agentId);

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">{docs?.length ?? 0} document{docs?.length !== 1 ? "s" : ""}</p>
      {(docs ?? []).length === 0 ? (
        <EmptyState compact icon={FolderOpen} title="No documents yet" description="Contracts, licenses and other files for this agent will appear here." />
      ) : (
        <div className="space-y-2">
          {(docs ?? []).map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{doc.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{doc.category} · {format(new Date(doc.createdAt), "MMM d, yyyy")}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
