import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";
import { useGetMe, useGetMyOrganization, useGetOrgSettings, useUpdateOrgSettings, getGetOrgSettingsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Settings, User, Building2, Shield, CalendarClock, Copy } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function AhipSeasonCard() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useGetOrgSettings();
  const { mutateAsync: save, isPending } = useUpdateOrgSettings();

  const [form, setForm] = useState({
    ahipSeasonOpenMonth: 7,
    ahipSeasonOpenDay: 1,
    ahipDeadlineMonth: 12,
    ahipDeadlineDay: 7,
    ahipReminderEnabled: true,
    ahipReminderIntervalWeeks: 2,
  });

  useEffect(() => {
    if (settings) {
      setForm({
        ahipSeasonOpenMonth: settings.ahipSeasonOpenMonth,
        ahipSeasonOpenDay: settings.ahipSeasonOpenDay,
        ahipDeadlineMonth: settings.ahipDeadlineMonth,
        ahipDeadlineDay: settings.ahipDeadlineDay,
        ahipReminderEnabled: settings.ahipReminderEnabled,
        ahipReminderIntervalWeeks: settings.ahipReminderIntervalWeeks,
      });
    }
  }, [settings]);

  const handleSave = async () => {
    try {
      await save({ data: form });
      void qc.invalidateQueries({ queryKey: getGetOrgSettingsQueryKey() });
      toast.success("AHIP season settings saved");
    } catch {
      toast.error("Failed to save settings");
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            AHIP Season Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" />
          AHIP Season Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Configure the AHIP certification season window. Automated reminders will only be sent to agents who haven't completed AHIP during this period.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Season Opens</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Month</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={form.ahipSeasonOpenMonth}
                  onChange={(e) => setForm(p => ({ ...p, ahipSeasonOpenMonth: parseInt(e.target.value) }))}
                >
                  {MONTHS.map((m, i) => (
                    <option key={i + 1} value={i + 1}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Day</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={form.ahipSeasonOpenDay}
                  onChange={(e) => setForm(p => ({ ...p, ahipSeasonOpenDay: parseInt(e.target.value) || 1 }))}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Season Deadline</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Month</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={form.ahipDeadlineMonth}
                  onChange={(e) => setForm(p => ({ ...p, ahipDeadlineMonth: parseInt(e.target.value) }))}
                >
                  {MONTHS.map((m, i) => (
                    <option key={i + 1} value={i + 1}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Day</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={form.ahipDeadlineDay}
                  onChange={(e) => setForm(p => ({ ...p, ahipDeadlineDay: parseInt(e.target.value) || 1 }))}
                />
              </div>
            </div>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Reminders</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable automated AHIP reminders</p>
              <p className="text-xs text-muted-foreground mt-0.5">Send email and SMS reminders to agents missing AHIP within the season window</p>
            </div>
            <Switch
              checked={form.ahipReminderEnabled}
              onCheckedChange={(v) => setForm(p => ({ ...p, ahipReminderEnabled: v }))}
            />
          </div>
          {form.ahipReminderEnabled && (
            <div className="flex items-center gap-3">
              <Label className="text-sm text-muted-foreground whitespace-nowrap">Remind every</Label>
              <Input
                type="number"
                min={1}
                max={52}
                className="w-20"
                value={form.ahipReminderIntervalWeeks}
                onChange={(e) => setForm(p => ({ ...p, ahipReminderIntervalWeeks: parseInt(e.target.value) || 1 }))}
              />
              <span className="text-sm text-muted-foreground">weeks</span>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { user: clerkUser } = useUser();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: org, isLoading: orgLoading } = useGetMyOrganization();

  return (
    <div className="p-6 space-y-5 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your profile and organization</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <User className="h-4 w-4 text-primary" />
            Your Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {meLoading ? (
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-36" />
              </div>
            </div>
          ) : me ? (
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarImage src={clerkUser?.imageUrl} />
                <AvatarFallback className="text-lg bg-primary/10 text-primary">
                  {me.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-semibold text-lg">{me.fullName}</p>
                <p className="text-sm text-muted-foreground">{me.email}</p>
                <Badge variant="secondary" className="mt-1 text-xs capitalize">
                  {me.role.replace("_", " ")}
                </Badge>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Organization */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            Organization
          </CardTitle>
        </CardHeader>
        <CardContent>
          {orgLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          ) : org ? (
            <div className="space-y-3">
              <div>
                <p className="font-semibold">{org.name}</p>
                <p className="text-sm text-muted-foreground">/{org.slug}</p>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Plan</span>
                <Badge variant="secondary" className="capitalize">{org.planTier}</Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Created</span>
                <span>{new Date(org.createdAt).toLocaleDateString()}</span>
              </div>
              {me && (me.role === "super_admin" || me.role === "agency_admin") && (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground shrink-0">Agency ID</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="truncate text-xs">{org.id}</code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => {
                        navigator.clipboard.writeText(org.id)
                          .then(() => toast.success("Agency ID copied"))
                          .catch(() => toast.error("Could not copy. Select the ID and copy it instead."));
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* AHIP Season Config */}
      <AhipSeasonCard />

      {/* Security */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Manage your password, MFA, and active sessions through the account settings below.
          </p>
          <div className="mt-3 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            Authentication is managed by Clerk. All sessions are secured with HTTPS and short-lived tokens.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
