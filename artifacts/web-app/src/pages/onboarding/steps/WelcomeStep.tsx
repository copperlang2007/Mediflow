import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileText, Users, PenTool, Send } from "lucide-react";

export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <Card data-testid="welcome-step">
      <CardHeader>
        <CardTitle>Welcome to carrier contracting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Your administrator has invited you to complete carrier contracting.
          You'll provide some information about yourself, choose which carriers
          you want to write business with, and sign the resulting paperwork.
          The whole process usually takes 10-15 minutes.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Step
            icon={FileText}
            title="1. Your profile"
            body="Personal info, entity type, and your E&O coverage."
          />
          <Step
            icon={Users}
            title="2. Carriers"
            body="Pick which carriers and states you want appointments for."
          />
          <Step
            icon={PenTool}
            title="3. Sign paperwork"
            body="An admin reviews your selections and generates the contracting packets."
          />
          <Step
            icon={Send}
            title="4. Submitted"
            body="We send the signed packets to each carrier's appointment desk."
          />
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
          <p>
            Your SSN and EIN are encrypted at rest with AES-256-GCM and only
            visible to you (on your own profile) and to authorized
            administrators.
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={onContinue}>Get started</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Step({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex gap-3">
      <Icon className="h-5 w-5 text-primary shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{body}</p>
      </div>
    </div>
  );
}
