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
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Settings, User, Building2, Shield, CalendarClock, Copy, MessageSquareWarning, PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { PageShell } from "@/components/ops";
import { UserPlus, CreditCard, Lock, ArrowLeftRight, Activity, ChevronRight } from "lucide-react";

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
      <SectionCard title="AHIP season" icon={CalendarClock}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="AHIP season"
      description="When agents can take AHIP each year. Reminders only go to agents who haven't finished it during this window."
      icon={CalendarClock}
      contentClassName="space-y-5"
    >

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
    </SectionCard>
  );
}

const ADMIN_LINKS = [
  { href: "/settings/team", label: "Team", text: "Invite people and set their roles", icon: UserPlus },
  { href: "/settings/billing", label: "Billing", text: "Your plan, seats and invoices", icon: CreditCard },
  { href: "/admin-carriers", label: "Carriers", text: "Carriers you sell and their connections", icon: Building2 },
  { href: "/admin-compliance", label: "Security & HIPAA checklist", text: "Security checks, access review and logs", icon: Lock },
  { href: "/data-migration", label: "Import & Migration", text: "Bring in agents and clients", icon: ArrowLeftRight },
  { href: "/admin/health", label: "System Health", text: "Background jobs and integrations", icon: Activity },
];
/**
 * TCPA consent enforcement for automated texts. On by default; turning it off
 * lets sequences and automation rules text contacts with no recorded consent,
 * so the switch asks for confirmation and the change is audited server-side.
 */
function TextingConsentCard() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useGetOrgSettings();
  const { mutateAsync: save, isPending } = useUpdateOrgSettings();
  const enforced = settings?.requireSmsConsent ?? true;

  const setEnforced = async (next: boolean) => {
    if (!next && !window.confirm(
      "Automated texts will go to contacts with no recorded TCPA consent. Only turn this off if consent is captured and tracked outside agencyBRIDGE. Continue?",
    )) {
      return;
    }
    try {
      await save({ data: { requireSmsConsent: next } });
      void qc.invalidateQueries({ queryKey: getGetOrgSettingsQueryKey() });
      toast.success(next ? "Consent is now required for automated texts" : "Consent requirement turned off");
    } catch {
      toast.error("Failed to save setting");
    }
  };

  return (
    <SectionCard title="Texting compliance" icon={MessageSquareWarning}>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Require TCPA consent for automated texts</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Sequences and automation rules only text contacts with a recorded consent date and source.
                Opt-outs and recipients' local texting hours are always enforced.
              </p>
            </div>
            <Switch
              checked={enforced}
              disabled={isPending}
              onCheckedChange={(v) => void setEnforced(v)}
              aria-label="Require TCPA consent for automated texts"
            />
          </div>
        )}
    </SectionCard>
  );
}

/**
 * Voice-calling consent for clients imported from GoHighLevel. OFF by default.
 * Only agency admins can change it (the API enforces this; the switch is also
 * disabled for everyone else). This is NOT a compliance finding.
 */
export function ImportedClientConsentCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: settings, isLoading, isError } = useGetOrgSettings();
  const { mutateAsync: save, isPending } = useUpdateOrgSettings();
  const enabled = settings?.allowImportedContactConsent === true;
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const persist = async (next: boolean) => {
    try {
      await save({ data: { allowImportedContactConsent: next } });
      void qc.invalidateQueries({ queryKey: getGetOrgSettingsQueryKey() });
      toast.success(next ? "Calls to imported clients are now allowed" : "Calls to imported clients are turned off");
    } catch {
      toast.error("Failed to save setting");
    }
  };

  const onToggle = (next: boolean) => {
    if (next) {
      setUnderstood(false);
      setConfirming(true);
    } else {
      void persist(false);
    }
  };

  return (
    <SectionCard title="Calling compliance" icon={PhoneCall}>
      {isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load this setting. Refresh to try again.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Allow calls to imported clients with no do-not-contact flag</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Off by default. Calls normally need a documented consent date and source on the contact.
                When this is on, a client imported from GoHighLevel can also be called if nothing marks
                them do-not-contact.
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={isPending || !isAdmin}
              onCheckedChange={onToggle}
              aria-label="Allow calls to imported clients with no do-not-contact flag"
            />
          </div>
          <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs" role="note">
            <p className="font-medium">Read before turning this on</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>No do-not-contact flag is not the same as consent. Consent for these clients is not recorded in agencyBRIDGE; it is said to be on the call recordings.</li>
              <li>The national and state do-not-call registries are not checked.</li>
              <li>Rules for existing customers have time limits.</li>
              <li>Confirm this with your attorney or compliance counsel first. This setting is not a compliance guarantee.</li>
            </ul>
            <p className="mt-1">Anyone marked do-not-contact, opted out, or not linked to GoHighLevel is still blocked. Each call is recorded with the basis it used.</p>
          </div>
          {!isAdmin && (
            <p className="text-xs text-muted-foreground">Only agency admins can change this setting.</p>
          )}
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={(o) => { if (!isPending) setConfirming(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow calls to imported clients?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Clients imported from GoHighLevel with no do-not-contact flag will become callable without a
                  documented consent date and source.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>No flag is not the same as consent.</li>
                  <li>The national and state do-not-call registries are not checked.</li>
                  <li>Existing-customer rules have time limits.</li>
                  <li>Confirm with counsel before relying on this.</li>
                </ul>
                <p>The change is recorded in the audit log.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={understood}
              onCheckedChange={(v) => setUnderstood(v === true)}
              aria-label="I understand and have confirmed this with counsel"
              className="mt-0.5"
            />
            <span>I understand this, and I have confirmed or will confirm it with counsel.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!understood || isPending}
              onClick={() => { void persist(true); }}
            >
              Turn on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

export default function SettingsPage() {
  const { user: clerkUser } = useUser();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: org, isLoading: orgLoading } = useGetMyOrganization();
  const isAdmin = !!me && (me.role === "super_admin" || me.role === "agency_admin");

  return (
    <PageShell>
      <PageHeader title="Settings" subtitle="Your profile, your agency, and the AHIP season" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="space-y-6 lg:col-span-1">
      {/* Profile */}
      <SectionCard title="Your profile" icon={User}>
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
                <AvatarFallback className="text-lg bg-navy-800 text-white">
                  {me.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="font-display font-semibold text-lg truncate">{me.fullName}</p>
                <p className="text-sm text-muted-foreground truncate">{me.email}</p>
                <StatusPill tone="navy" className="mt-1.5 capitalize">
                  {me.role.replace(/_/g, " ")}
                </StatusPill>
              </div>
            </div>
          ) : null}
      </SectionCard>

      {/* Organization */}
      <SectionCard title="Agency" icon={Building2}>
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
                <StatusPill tone="info" className="capitalize">{org.planTier}</StatusPill>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Created</span>
                <span>{new Date(org.createdAt).toLocaleDateString()}</span>
              </div>
              {isAdmin && (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground shrink-0">Agency ID</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="truncate text-xs">{org.id}</code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => {
                        try {
                          void navigator.clipboard.writeText(org.id)
                            .then(() => toast.success("Agency ID copied"))
                            .catch(() => toast.error("Could not copy. Select the ID and copy it instead."));
                        } catch {
                          toast.error("Could not copy. Select the ID and copy it instead.");
                        }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
      </SectionCard>

      <TextingConsentCard />

      <ImportedClientConsentCard isAdmin={isAdmin} />

      {/* Security */}
      <SectionCard title="Sign-in & security" icon={Shield}>
          <p className="text-sm text-muted-foreground">
            Manage your password, MFA, and active sessions from your account menu.
          </p>
          <div className="mt-3 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            Authentication is managed by Clerk. All sessions are secured with HTTPS and short-lived tokens.
          </div>
      </SectionCard>
        </div>

        <div className="space-y-6 lg:col-span-2">
      {/* AHIP Season Config */}
      <AhipSeasonCard />

      {isAdmin && (
        <SectionCard title="Agency admin" description="Everything else you can set up for your agency" icon={Settings}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ADMIN_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="group flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-accent/40 hover:bg-muted/50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                  <l.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{l.label}</span>
                  <span className="block text-xs text-muted-foreground truncate">{l.text}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-accent" />
              </Link>
            ))}
          </div>
        </SectionCard>
      )}
        </div>
      </div>
    </PageShell>
  );
}
