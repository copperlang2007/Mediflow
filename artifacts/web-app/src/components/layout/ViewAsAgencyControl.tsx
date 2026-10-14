import { useEffect, useMemo, useState } from "react";
import { Eye, X } from "lucide-react";
import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Agency = { id: string; name: string; slug: string };
const VIEW_AS_KEY = "mediflow:view-as-org";
const SUPPORT_REASON_KEY = "mediflow:support-edit-reason";

function readActiveOrgId(): string | null {
  try { return globalThis.localStorage?.getItem(VIEW_AS_KEY) ?? null; } catch { return null; }
}

/** Agencies a super admin can view read-only, plus the one being viewed now. */
function useViewAsAgencies(enabled: boolean) {
  const { data: me } = useGetMe();
  const [allAgencies, setAgencies] = useState<Agency[]>([]);
  // Your own agency is just "using it" (writable, nothing read-only about it),
  // so it is never offered as an agency to view.
  const agencies = useMemo(() => allAgencies.filter((a) => a.id !== me?.orgId), [allAgencies, me?.orgId]);
  const [error, setError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [activeOrgId] = useState<string | null>(readActiveOrgId);
  const [supportReason, setSupportReason] = useState<string | null>(() => {
    try { return globalThis.sessionStorage?.getItem(SUPPORT_REASON_KEY) ?? null; } catch { return null; }
  });

  useEffect(() => {
    if (!enabled) return;
    void apiFetch<{ agencies: Agency[] }>("/api/admin/agencies")
      .then((result) => { setAgencies(result.agencies); setError(null); setMfaRequired(false); })
      .catch((cause: { status?: number; data?: { error?: string } }) => {
        setAgencies([]);
        const needsMfa = cause.status === 403 && cause.data?.error === "mfa_required";
        setMfaRequired(needsMfa);
        setError(needsMfa ? null : "Could not load agencies. Refresh to try again.");
      });
  }, [enabled]);

  const setView = (orgId: string) => {
    if (!orgId) return;
    sessionStorage.removeItem(SUPPORT_REASON_KEY);
    localStorage.setItem(VIEW_AS_KEY, orgId);
    window.location.reload();
  };
  const exitView = () => {
    localStorage.removeItem(VIEW_AS_KEY);
    sessionStorage.removeItem(SUPPORT_REASON_KEY);
    window.location.reload();
  };

  const enableSupportEdit = () => {
    const reason = window.prompt("Why are you helping this agency? This reason is recorded with each profile edit.")?.trim();
    if (!reason) return;
    if (reason.length < 10 || reason.length > 240) {
      window.alert("Enter a reason between 10 and 240 characters.");
      return;
    }
    sessionStorage.setItem(SUPPORT_REASON_KEY, reason);
    setSupportReason(reason);
  };
  const disableSupportEdit = () => {
    sessionStorage.removeItem(SUPPORT_REASON_KEY);
    setSupportReason(null);
  };

  return { agencies, error, mfaRequired, activeOrgId, supportReason, setView, exitView, enableSupportEdit, disableSupportEdit };
}

/** Viewing agencies needs two-step verification; this points at the page that enrolls it. */
function MfaLink({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <Link href="/settings/security" className={cn("underline underline-offset-2", className)} onClick={onNavigate}>
      Set up two-step verification to view agencies
    </Link>
  );
}

function AgencySelect({
  agencies,
  onPick,
  className,
}: {
  agencies: Agency[];
  onPick: (id: string) => void;
  className?: string;
}) {
  return (
    <select
      className={cn("h-8 rounded-md border border-input bg-background px-2 text-xs", className)}
      value=""
      onChange={(event) => onPick(event.target.value)}
      aria-label="View agency"
    >
      <option value="">Select agency</option>
      {agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
    </select>
  );
}

/**
 * Top-bar control for super admins to view another agency read-only. The one
 * write allowed while viewing is invitations (Team page), audited server-side.
 *
 * The "Select agency" dropdown only sits in the bar on wide screens (xl+);
 * below that the account menu offers the same picker (<ViewAsAgencyDialog>).
 * While an agency is being viewed the read-only badge always shows,
 * shortened on small screens.
 */
export function ViewAsAgencyControl({ enabled }: { enabled: boolean }) {
  const { agencies, error, mfaRequired, activeOrgId, supportReason, setView, exitView, enableSupportEdit, disableSupportEdit } = useViewAsAgencies(enabled);
  if (!enabled) return null;

  const activeAgency = agencies.find((agency) => agency.id === activeOrgId);

  if (activeOrgId) {
    const name = activeAgency?.name ?? "agency";
    return (
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        title={supportReason ? `Helping ${name} — contact and agent profile edits enabled` : `Viewing ${name} — read-only, except inviting people from Team`}
      >
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden font-medium sm:inline truncate max-w-48">{supportReason ? `Helping ${name} - profile edits` : `Viewing ${name} - read-only`}</span>
        <span className="sr-only sm:hidden">{supportReason ? `Helping ${name}, profile edits enabled` : `Viewing ${name}, read-only`}</span>
        {error && <span role="alert" className="hidden md:inline">{error}</span>}
        {mfaRequired && <MfaLink className="hidden md:inline text-amber-700 dark:text-amber-300" />}
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={supportReason ? disableSupportEdit : enableSupportEdit}>
          {supportReason ? "Stop editing" : "Enable profile edits"}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20" onClick={exitView} aria-label="Exit agency view">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <label className="hidden xl:flex items-center gap-2 text-xs text-muted-foreground" title="View an agency read-only; you can still invite people from its Team page">
      <Eye className="h-4 w-4" />
      <span className="hidden 2xl:inline">View agency</span>
      <AgencySelect agencies={agencies} onPick={setView} className="max-w-44" />
      {error && <span role="alert" className="max-w-52 text-amber-700">{error}</span>}
      {mfaRequired && <MfaLink className="max-w-52 text-amber-700" />}
    </label>
  );
}

/** The same picker in a dialog, opened from the account menu on small screens. */
export function ViewAsAgencyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { agencies, error, mfaRequired, setView } = useViewAsAgencies(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>View an agency</DialogTitle>
          <DialogDescription>
            See another agency exactly as they do. Nothing can be changed, except inviting people from its Team page.
          </DialogDescription>
        </DialogHeader>
        <AgencySelect agencies={agencies} onPick={setView} className="h-10 w-full text-sm" />
        {error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{error}</p>}
        {mfaRequired && (
          <MfaLink className="text-sm text-amber-700 dark:text-amber-300" onNavigate={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
