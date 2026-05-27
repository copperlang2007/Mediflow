/**
 * System Health (admin-only).
 *
 * Tiny admin-only convenience page that calls the backend
 * `GET /api/admin/health/ai` endpoint introduced in PR #119 and renders the
 * structured response. The server already enforces the role gate (super_admin
 * / agency_admin) and rate-limits the upstream ping; we mirror the role check
 * client-side so non-admins see a clean "no access" panel instead of an
 * opaque 403, and we only render the documented fields so an unexpected
 * server response shape can't accidentally surface PHI-adjacent metadata.
 *
 * The endpoint is GET — the request body is never used by the server — so we
 * call it as GET via the shared `apiFetch` helper that already adds
 * `credentials: include` and normalises error responses.
 */
import { useCallback, useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
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
  azure: "bg-emerald-50 text-emerald-700 border-emerald-200",
  openai: "bg-blue-50 text-blue-700 border-blue-200",
  unset: "bg-red-50 text-red-700 border-red-200",
};

const ERROR_LABEL: Record<PingErrorCategory, string> = {
  auth_failed: "Authentication failed",
  rate_limited: "Rate limited",
  network: "Network error",
  not_found: "Not found",
  timeout: "Timeout",
  unknown: "Unknown error",
};

const ADMIN_ROLES = ["super_admin", "agency_admin"];

export default function AdminHealthPage() {
  const { data: me } = useGetMe();
  const isAdmin = Boolean(me && ADMIN_ROLES.includes(me.role));

  if (me && !isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent
            className="py-10 text-center text-sm text-muted-foreground"
            data-testid="admin-health-forbidden"
          >
            You don't have access to system health checks.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Activity className="h-6 w-6" />
          System Health
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Verify the AI provider wiring before launching real workflows.
        </p>
      </div>
      <AiProviderCard />
    </div>
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

  const runProbe = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await apiFetch<AiHealthResult>("/api/admin/health/ai");
      setState({
        loading: false,
        result: normalizeResult(result),
        error: null,
        checkedAt: Date.now(),
      });
    } catch (err) {
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

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    void runProbe();
  }, [runProbe]);

  const hasRun = state.checkedAt !== null;

  return (
    <Card data-testid="ai-health-card">
      <CardHeader>
        <CardTitle className="text-lg">AI provider</CardTitle>
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
            className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
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
          <p className="text-sm font-medium text-red-700 mb-1">
            Environment issues
          </p>
          <ul className="list-disc list-inside text-sm text-red-700 space-y-0.5">
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
            className="text-sm text-emerald-700 flex items-center gap-1.5"
            data-testid="ai-health-ping-ok"
          >
            <CheckCircle2 className="h-4 w-4" />
            OK in {result.ping.latencyMs ?? 0}ms, model{" "}
            <code className="text-xs">{result.ping.model ?? "unknown"}</code>
          </p>
        ) : (
          <p
            className="text-sm text-red-700 flex items-center gap-1.5"
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
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="ok" />
      ) : (
        <XCircle className="h-4 w-4 text-red-600" aria-label="not ok" />
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
