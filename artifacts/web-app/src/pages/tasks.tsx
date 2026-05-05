import { CheckSquare } from "lucide-react";

export default function TasksPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Task management and onboarding checklists</p>
      </div>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <CheckSquare className="h-16 w-16 text-muted-foreground/20 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">Coming in Task #2</p>
        <p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">
          Task templates, onboarding/offboarding checklists, and automated task assignment will be in the Agent Lifecycle Hub.
        </p>
      </div>
    </div>
  );
}
