/**
 * System Health (admin-only).
 *
 * Tiny admin-only convenience page that calls the backend
 * `GET /api/admin/health/ai` endpoint introduced in PR #119 and renders the
 * structured response. The server already enforces the role gate (super_admin
 * / agency_admin / compliance_manager) and rate-limits the upstream ping; we
 * mirror the role check client-side so non-admins see a clean "no access"
 * panel instead of an opaque 403, and we only render the documented fields so
 * an unexpected server response shape can't accidentally surface PHI-adjacent
 * metadata.
 *
 * The endpoint is GET — the request body is never used by the server — so we
 * call it as GET via the shared `apiFetch` helper that already adds
 * `credentials: include` and normalises error responses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsAdmin, ADMIN_OR_COMPLIANCE_ROLES } from "@/lib/auth/useIsAdmin";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Activity, AlertCircle, CheckCircle2, RefreshCcw, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell } from "@/components/ops";
import { Database, Cog, Server, Sparkles, Lock } from "lucide-react";

// ---------- Response shape -------------------------------------------------
// Mirrors `routes/adminHealth.ts`. We intentionally don't import the server
// type — the web-app and api-server are independent packages and copying the
// type would couple them. The fields below are the documented contract.

export type HealthProvider = "azure" | "openai" | "unset";

export type PingErrorCategory =
  | "auth_failed"
  | "rate_limited"
  | "network"
  | "not_found"
  | "timeout"
  | "unknown";

export interface AiHealthPing {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  category?: PingErrorCategory;
  message?: string;
}

export interface AiHealthResult {
  provider: HealthProvider;
  configured: boolean;
  envValid: boolean;
  envIssues: string[];
  ping: AiHealthPing;
  warnings: string[];
}

const PROVIDER_BADGE: Record<HealthProvider, string> = {
  azure: "bg-success/12 text-success border-success/25",
  openai: "bg-accent/10 text-accent border-accent/25",
  unset: "bg-destructive/10 text-destructive border-destructive/25",
};

// ---------- Core services ---------------------------------------------------
// GET /api/readyz is the same probe the load balancer uses: it proves the
// database answers and the background workers are up. Read-only, no PHI.

type ReadyCheck = "ok" | string;
interface ReadyResponse {
  status: string;
  checks?: Record<string, ReadyCheck>;
}

const SERVICE_LABELS: Record<string, { label: string; text: string; icon: typeof Database }> = {
  db: { label: "Database", text: "Stores every record", icon: Database },
  workers: { label: "Background jobs", text: "Reminders, syncs, reconciliation", icon: Cog },
};

function CoreServicesCard() {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["system-health", "readyz"],
    queryFn: async (): Promise<ReadyResponse | null> => {
      try {
        const res = await fetch(`${base}/api/readyz`, { credentials: "include" });
        const body = (await res.json().catch(() => null)) as ReadyResponse | null;
        return body ?? { status: res.ok ? "ok" : "error" };
      } catch {
        return null;
      }
    },
    retry: false,
    refetchInterval: 60_000,
  });

  const checks = Object.entries(data?.checks ?? {});
  const allOk = data?.status === "ok";

  return (
    <SectionCard
      title="Core services"
      description="Checked every minute — the same test our hosting uses to decide if Mediflow is up"
      icon={Server}
      actions={
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCcw className={`h-4 w-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          Check now
        </Button>
      }
    >
      {isLoading ? (
        <div className="h-20 animate-pulse rounded-lg bg-muted" />
      ) : !data ? (
        <EmptyState compact icon={AlertCircle} title="Couldn't reach the service check" description="Your connection may be down, or the server is restarting." />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusPill tone={allOk ? "success" : "danger"} className="text-sm px-3 py-1">
              {allOk ? "All systems running" : "Something needs attention"}
            </StatusPill>
            {dataUpdatedAt > 0 && (
              <span className="text-xs text-muted-foreground">Checked {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3">
            {checks.map(([key, value]) => {
              const meta = SERVICE_LABELS[key] ?? { label: key, text: "", icon: Server };
              const ok = value === "ok";
              return (
                <div key={key} className="flex items-center gap-3 rounded-lg border border-border p-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${ok ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive"}`}>
                    <meta.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{meta.label}</p>
                    {meta.text && <p className="text-xs text-muted-foreground">{meta.text}</p>}
                  </div>
                  <StatusPill tone={ok ? "success" : "danger"}>{ok ? "Running" : "Down"}</StatusPill>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

const ERROR_LABEL: Record<PingErrorCategory, string> = {
  auth_failed: "Authentication failed",
  rate_limited: "Rate limited",
  network: "Network error",
  not_found: "Not found",
  timeout: "Timeout",
  unknown: "Unknown error",
};

export default function AdminHealthPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES);

  if (!meLoading && !isAdmin) {
    return (
      <PageShell>
        <Card className="rounded-xl">
          <CardContent className="p-0" data-testid="admin-health-forbidden">
            <EmptyState
              icon={Lock}
              title="You don't have access to system health checks."
              description="System health is available to agency admins and compliance managers."
            />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="System Health"
        subtitle="Is everything running? Check the core services and the AI assistant's connection."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <CoreServicesCard />
        <AiProviderCard />
      </div>
    </PageShell>
  );
}

// ---------- AI provider card -----------------------------------------------

interface AiProbeState {
  loading: boolean;
  result: AiHealthResult | null;
  error: string | null;
  checkedAt: number | null;
}

const INITIAL_STATE: AiProbeState = {
  loading: false,
  result: null,
  error: null,
  checkedAt: null,
};

export function AiProviderCard() {
  const [state, setState] = useState<AiProbeState>(INITIAL_STATE);
  // Track the in-flight AbortController so we can cancel on unmount or when
  // the user triggers a Refresh while the previous probe hasn't returned.
  // Without this an unmount mid-fetch logs a setState-on-unmounted warning.
  const controllerRef = useRef<AbortController | null>(null);

  const runProbe = useCallback(async () => {
    // Cancel any prior in-flight call before kicking off a new one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await apiFetch<AiHealthResult>("/api/admin/health/ai", {
        signal: controller.signal,
      });
      // If the request was superseded or unmounted, skip the state write —
      // the next runner (or unmount cleanup) already owns the UI.
      if (controller.signal.aborted) return;
      setState({
        loading: false,
        result: normalizeResult(result),
        error: null,
        checkedAt: Date.now(),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error
          ? err.message
          : "Failed to reach the health endpoint";
      setState({
        loading: false,
        result: null,
        error: message,
        checkedAt: Date.now(),
      });
    }
  }, []);

  // On unmount, abort any in-flight probe so we don't setState into a
  // component that's already gone. `apiFetch` rejects with an AbortError
  // which the catch above swallows because `signal.aborted` is true.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    void runProbe();
  }, [runProbe]);

  const hasRun = state.checkedAt !== null;

  return (
    <Card data-testid="ai-health-card" className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-accent" />
          AI provider
        </CardTitle>
        <CardDescription>
          Calls the configured provider with a one-token ping. No PHI is sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          {!hasRun ? (
            <Button
              onClick={runProbe}
              disabled={state.loading}
              data-testid="ai-health-test-btn"
            >
              {state.loading && <Spinner className="mr-2" />}
              Test connection
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={reset}
              disabled={state.loading}
              data-testid="ai-health-refresh-btn"
            >
              {state.loading ? (
                <Spinner className="mr-2" />
              ) : (
                <RefreshCcw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          )}
          {state.checkedAt && !state.loading && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="ai-health-checked-at"
            >
              Checked {new Date(state.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {state.error && (
          <div
            className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="ai-health-fetch-error"
          >
            {state.error}
          </div>
        )}

        {state.result && <ResultPanel result={state.result} />}
      </CardContent>
    </Card>
  );
}

function ResultPanel({ result }: { result: AiHealthResult }) {
  return (
    <div className="space-y-3" data-testid="ai-health-result">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Provider:</span>
        <Badge
          variant="outline"
          className={PROVIDER_BADGE[result.provider]}
          data-testid="ai-health-provider-badge"
        >
          {result.provider}
        </Badge>
      </div>

      <CheckRow
        label="Configured"
        ok={result.configured}
        testId="ai-health-configured"
      />
      <CheckRow
        label="Environment valid"
        ok={result.envValid}
        testId="ai-health-env-valid"
      />

      {result.envIssues.length > 0 && (
        <div data-testid="ai-health-env-issues">
          <p className="text-sm font-medium text-destructive mb-1">
            Environment issues
          </p>
          <ul className="list-disc list-inside text-sm text-destructive space-y-0.5">
            {result.envIssues.map((issue, i) => (
              <li key={i} data-testid={`ai-health-env-issue-${i}`}>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t pt-3">
        <p className="text-sm font-medium mb-1">Ping</p>
        {result.ping.ok ? (
          <p
            className="text-sm text-success flex items-center gap-1.5"
            data-testid="ai-health-ping-ok"
          >
            <CheckCircle2 className="h-4 w-4" />
            OK in {result.ping.latencyMs ?? 0}ms, model{" "}
            <code className="text-xs">{result.ping.model ?? "unknown"}</code>
          </p>
        ) : (
          <p
            className="text-sm text-destructive flex items-center gap-1.5"
            data-testid="ai-health-ping-fail"
          >
            <XCircle className="h-4 w-4" />
            {ERROR_LABEL[result.ping.category ?? "unknown"]}:{" "}
            {result.ping.message ?? "Upstream call failed"}
          </p>
        )}
      </div>

      {result.warnings.length > 0 && (
        <div data-testid="ai-health-warnings">
          <p className="text-sm font-medium text-amber-700 mb-1 flex items-center gap-1.5">
            <AlertCircle className="h-4 w-4" />
            Warnings
          </p>
          <ul className="list-disc list-inside text-sm text-amber-700 space-y-0.5">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CheckRow({
  label,
  ok,
  testId,
}: {
  label: string;
  ok: boolean;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm" data-testid={testId}>
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-success" aria-label="ok" />
      ) : (
        <XCircle className="h-4 w-4 text-destructive" aria-label="not ok" />
      )}
      <span>{label}</span>
    </div>
  );
}

/**
 * Defensively keep only the documented response fields and coerce types so a
 * malformed server response can't break the render. We do NOT pass the raw
 * object through to React — the server already redacts, but the UI layer is a
 * second line of defense.
 */
export function normalizeResult(raw: unknown): AiHealthResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawPing = (r.ping ?? {}) as Record<string, unknown>;
  const provider: HealthProvider =
    r.provider === "azure" || r.provider === "openai" ? r.provider : "unset";
  const category =
    typeof rawPing.category === "string" &&
    (["auth_failed", "rate_limited", "network", "not_found", "timeout", "unknown"] as const).includes(
      rawPing.category as PingErrorCategory,
    )
      ? (rawPing.category as PingErrorCategory)
      : undefined;
  return {
    provider,
    configured: Boolean(r.configured),
    envValid: Boolean(r.envValid),
    envIssues: Array.isArray(r.envIssues)
      ? r.envIssues.filter((s): s is string => typeof s === "string")
      : [],
    ping: {
      ok: Boolean(rawPing.ok),
      latencyMs:
        typeof rawPing.latencyMs === "number" ? rawPing.latencyMs : undefined,
      model: typeof rawPing.model === "string" ? rawPing.model : undefined,
      category,
      message:
        typeof rawPing.message === "string" ? rawPing.message : undefined,
    },
    warnings: Array.isArray(r.warnings)
      ? r.warnings.filter((s): s is string => typeof s === "string")
      : [],
  };
}
