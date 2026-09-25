import { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Agency = { id: string; name: string; slug: string };
const VIEW_AS_KEY = "mediflow:view-as-org";

export function ViewAsAgencyControl({ enabled }: { enabled: boolean }) {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeOrgId] = useState<string | null>(() => {
    try { return globalThis.localStorage?.getItem(VIEW_AS_KEY) ?? null; } catch { return null; }
  });

  useEffect(() => {
    if (!enabled) return;
    void apiFetch<{ agencies: Agency[] }>("/api/admin/agencies")
      .then((result) => { setAgencies(result.agencies); setError(null); })
      .catch((cause: { status?: number; data?: { error?: string } }) => {
        setAgencies([]);
        setError(cause.status === 403 && cause.data?.error === "mfa_required"
          ? "Enable MFA in account security to view agencies."
          : "Could not load agencies. Refresh to try again.");
      });
  }, [enabled]);

  if (!enabled) return null;

  const activeAgency = agencies.find((agency) => agency.id === activeOrgId);
  const setView = (orgId: string) => {
    if (!orgId) return;
    localStorage.setItem(VIEW_AS_KEY, orgId);
    window.location.reload();
  };
  const exitView = () => {
    localStorage.removeItem(VIEW_AS_KEY);
    window.location.reload();
  };

  if (activeOrgId) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
        <Eye className="h-3.5 w-3.5" />
        <span className="font-medium">Viewing {activeAgency?.name ?? "agency"} - read-only</span>
        {error && <span role="alert">{error}</span>}
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-amber-900 hover:bg-amber-100" onClick={exitView} aria-label="Exit agency view">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground" title="View an agency without permission to create, edit, or delete data">
      <Eye className="h-4 w-4" />
      <span className="hidden xl:inline">View agency</span>
      <select className="h-8 max-w-44 rounded-md border border-input bg-background px-2 text-xs" value="" onChange={(event) => setView(event.target.value)} aria-label="View agency">
        <option value="">Select agency</option>
        {agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
      </select>
      {error && <span role="alert" className="max-w-52 text-amber-700">{error}</span>}
    </label>
  );
}
