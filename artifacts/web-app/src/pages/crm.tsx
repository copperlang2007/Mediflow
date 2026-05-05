import { PhoneCall } from "lucide-react";

export default function CRMPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Contacts, leads, pipelines, and deals</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <PhoneCall className="h-16 w-16 text-muted-foreground/20 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">Coming in Task #3</p>
        <p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">
          Full CRM with contacts, leads, pipeline kanban board, two-way SMS/email, and automated sequences.
        </p>
      </div>
    </div>
  );
}
