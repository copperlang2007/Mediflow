/**
 * Enrollment applications received from EnrollHere / Sunfire for one contact.
 *
 * The list shows plan-level facts only. "Full application" (admins and
 * compliance) fetches the decrypted application; every open is recorded in
 * the audit log server-side, so the full view is never cached here.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, ShieldAlert } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/shared";

interface ApplicationSummary {
  id: string;
  confirmationCode: string | null;
  currentVersion: number;
  lastEventType: string | null;
  carrierName: string | null;
  planName: string | null;
  planType: string | null;
  snpType: string | null;
  policyStatus: string | null;
  effectiveDate: string | null;
  signatureDate: string | null;
  agentEmail: string | null;
  updatedAt: string;
  /** Admins and compliance, or the agent who services this client. */
  canViewFull?: boolean;
}

interface FullApplication {
  application: { id: string; confirmationCode: string | null; planName: string | null };
  version: number;
  eventType: string | null;
  receivedAt: string;
  versions: { version: number; eventType: string | null; receivedAt: string }[];
  medicareId: string | null;
  medicaidNumber: string | null;
  payload: unknown;
}

const pretty = (code: string | null | undefined, prefix: RegExp) =>
  code ? code.replace(prefix, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null;

export function Tree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">none</span>;
    return (
      <ul className="space-y-1">
        {value.map((v, i) => <li key={i} className="pl-3 border-l"><Tree value={v} depth={depth + 1} /></li>)}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="space-y-1">
        {entries.map(([k, v]) =>
          v !== null && typeof v === "object" ? (
            <details key={k} open={depth < 1} className="pl-3 border-l">
              <summary className="cursor-pointer text-sm font-medium">{k}</summary>
              <div className="mt-1"><Tree value={v} depth={depth + 1} /></div>
            </details>
          ) : (
            <div key={k} className="pl-3 text-sm grid grid-cols-[minmax(8rem,auto)_1fr] gap-2">
              <span className="text-muted-foreground">{k}</span>
              <span className="break-words"><Tree value={v} depth={depth + 1} /></span>
            </div>
          ),
        )}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

export function FullApplicationDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["application-full", applicationId, version],
    queryFn: () => customFetch<FullApplication>(`/api/applications/${applicationId}/full${version ? `?version=${version}` : ""}`),
    // Every view is audited: never serve it from cache.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    // Each fetch is an audited PHI view: only an explicit open or version
    // change fetches, never a window refocus or reconnect.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Full application{data?.application.confirmationCode ? ` · ${data.application.confirmationCode}` : ""}</DialogTitle>
        </DialogHeader>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5" />
          Contains protected health information. This view is recorded in the audit log.
        </p>
        {isLoading && <Skeleton className="h-64 w-full" />}
        {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Could not load the application."}</p>}
        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={String(data.version)} onValueChange={(v) => setVersion(Number(v))}>
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.versions.map((v) => (
                    <SelectItem key={v.version} value={String(v.version)}>
                      Version {v.version} · {pretty(v.eventType, /^PE_/) ?? "update"} · {new Date(v.receivedAt).toLocaleDateString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted-foreground">Medicare ID</dt><dd>{data.medicareId ?? "Not provided"}</dd></div>
              <div><dt className="text-muted-foreground">Medicaid number</dt><dd>{data.medicaidNumber ?? "Not provided"}</dd></div>
            </dl>
            <div className="rounded-md border p-3"><Tree value={data.payload} /></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface FullIntegrationRecord {
  id: string;
  source: string;
  eventType: string | null;
  receivedAt: string;
  payload: unknown;
}

/** Every value EnrollHere sent for one call, as received. Each open is an audited PHI view. */
export function FullIntegrationRecordDialog({ payloadId, onClose }: { payloadId: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["integration-payload", payloadId],
    queryFn: () => customFetch<FullIntegrationRecord>(`/api/integration-payloads/${payloadId}`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Full EnrollHere record</DialogTitle>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p role="alert" className="text-sm text-destructive">This record could not be opened.</p>}
        {data && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Received {new Date(data.receivedAt).toLocaleString()}
              {data.eventType ? ` · ${data.eventType}` : ""} · this view is recorded in the audit log.
            </p>
            <div className="rounded-md border p-3"><Tree value={data.payload} /></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ApplicationsTab({ contactId }: { contactId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["/api/contacts", contactId, "applications"],
    queryFn: () => customFetch<{ applications: ApplicationSummary[]; canViewFull: boolean }>(`/api/contacts/${contactId}/applications`),
    staleTime: 30_000,
  });

  if (isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;
  const apps = data?.applications ?? [];
  if (apps.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No applications yet"
        description="When an enrollment application for this person comes in from EnrollHere or Sunfire, it will be listed here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {apps.map((a) => {
        const status = pretty(a.policyStatus, /^POL_/);
        return (
          <div key={a.id} className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
                <FileText className="h-5 w-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.planName ?? "Unnamed plan"}</span>
                  {status && <StatusPill status={status}>{status}</StatusPill>}
                  {a.snpType && <StatusPill tone="navy">{a.snpType}</StatusPill>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {[a.carrierName, a.effectiveDate ? `Effective ${a.effectiveDate}` : null, a.confirmationCode ? `Sunfire ${a.confirmationCode}` : null, `Version ${a.currentVersion}`]
                    .filter(Boolean).join(" · ")}
                </p>
                {a.agentEmail && <p className="text-xs text-muted-foreground break-all">Agent: {a.agentEmail}</p>}
              </div>
            </div>
            {(a.canViewFull ?? data?.canViewFull) && (
              <Button size="sm" variant="outline" onClick={() => setOpenId(a.id)}>
                <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />Full application
              </Button>
            )}
          </div>
        );
      })}
      {data?.canViewFull && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          The full application contains health information. Every time it is opened, that is recorded in the audit log.
        </p>
      )}
      {openId && <FullApplicationDialog applicationId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
