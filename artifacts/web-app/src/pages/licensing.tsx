import { FileText } from "lucide-react";

export default function LicensingPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Licensing</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Track and manage state licenses across all agents</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <FileText className="h-16 w-16 text-muted-foreground/20 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">Coming in Task #2</p>
        <p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">
          Full state license management, renewal tracking, and automated alerts will be available in the Agent Lifecycle Hub module.
        </p>
      </div>
    </div>
  );
}
