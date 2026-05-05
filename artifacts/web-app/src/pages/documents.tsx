import { FolderOpen } from "lucide-react";

export default function DocumentsPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Documents</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Agent and contact document storage</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <FolderOpen className="h-16 w-16 text-muted-foreground/20 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">Coming in Task #2</p>
        <p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">
          Document upload, categorization, and secure retrieval for agents and contacts will be available in the next phase.
        </p>
      </div>
    </div>
  );
}
