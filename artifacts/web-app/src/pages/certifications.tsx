import { Award } from "lucide-react";

export default function CertificationsPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Certifications</h1>
        <p className="text-sm text-muted-foreground mt-0.5">AHIP, carrier certifications, and CE tracking</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Award className="h-16 w-16 text-muted-foreground/20 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">Coming in Task #2</p>
        <p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">
          AHIP tracking, carrier certification management, and CE credits will be available in the Agent Lifecycle Hub.
        </p>
      </div>
    </div>
  );
}
