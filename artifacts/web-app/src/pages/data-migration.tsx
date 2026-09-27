import { useState, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, TableFrame } from "@/components/ops";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  ArrowRight, History, Download, RefreshCcw, Database,
  Layers,
} from "lucide-react";

type TargetField = { field: string; label: string; required?: boolean };
type RowIssue = { row: number; field: string; message: string; severity?: "error" | "warning" };
type UploadResponse = { headers: string[]; sampleRows: Record<string, string>[]; totalRows: number; suggestedMapping: Record<string, string>; targetFields: TargetField[]; parseIssues?: RowIssue[] };
type ValidationResponse = {
  totalRows: number;
  errorCount: number;
  validRows: number;
  errors: RowIssue[];
  warningCount?: number;
  duplicateCount?: number;
  enrollmentCount?: number;
};
type ImportJob = { id: string; importType: string; status: string; totalRows: number; processedRows: number; createdCount: number; updatedCount: number; skippedCount: number; errorCount: number; warningCount?: number; fileName: string | null; createdAt: string; completedAt: string | null };
type ProgressEvent = { status: string; processed: number; total: number; errorCount: number };

const SKIP_FIELD_VALUE = "__skip_field__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUploadResponse(value: unknown): value is UploadResponse {
  return isRecord(value)
    && Array.isArray(value.headers) && value.headers.every((header) => typeof header === "string")
    && Array.isArray(value.sampleRows) && value.sampleRows.every(isRecord)
    && typeof value.totalRows === "number"
    && isRecord(value.suggestedMapping)
    && Array.isArray(value.targetFields)
    && value.targetFields.every((field) => (
      isRecord(field)
      && typeof field.field === "string"
      && typeof field.label === "string"
      && (field.required === undefined || typeof field.required === "boolean")
    ));
}

function isValidationResponse(value: unknown): value is ValidationResponse {
  return isRecord(value)
    && typeof value.totalRows === "number"
    && typeof value.errorCount === "number"
    && typeof value.validRows === "number"
    && Array.isArray(value.errors)
    && value.errors.every((error) => (
      isRecord(error)
      && typeof error.row === "number"
      && typeof error.field === "string"
      && typeof error.message === "string"
    ));
}

function isConfirmResponse(value: unknown): value is { jobId: string; totalRows: number } {
  return isRecord(value)
    && typeof value.jobId === "string"
    && value.jobId.length > 0
    && typeof value.totalRows === "number";
}

function getApiError(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string" && value.error
    ? value.error
    : fallback;
}

// ─── Wizard Step Indicator ─────────────────────────────────────────────────────
function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold transition-colors ${i < current ? "bg-success text-white" : i === current ? "bg-navy-800 text-white dark:bg-primary dark:text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            {i < current ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
          </div>
          <span className={`text-sm ${i === current ? "font-medium" : "text-muted-foreground"}`}>{step}</span>
          {i < steps.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground mx-1" />}
        </div>
      ))}
    </div>
  );
}

// ─── Generic Import Wizard ─────────────────────────────────────────────────────
function ImportWizard({
  title,
  description,
  uploadEndpoint,
  validateEndpoint,
  confirmEndpoint,
  steps = ["Upload", "Map Fields", "Validate", "Import"],
  extraConfirmFields,
}: {
  title: string;
  description: string;
  uploadEndpoint: string;
  validateEndpoint: string;
  confirmEndpoint: string;
  steps?: string[];
  extraConfirmFields?: { label: string; key: string; defaultValue?: string; options: { value: string; label: string }[] }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [uploadData, setUploadData] = useState<UploadResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const initialExtraValues = useMemo(
    () => Object.fromEntries(
      (extraConfirmFields ?? []).filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!]),
    ),
    [extraConfirmFields],
  );
  const [extraValues, setExtraValues] = useState<Record<string, string>>(initialExtraValues);
  const [loading, setLoading] = useState(false);

  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const handleFileSelect = async (f: File) => {
    setFile(f);
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`${base}${uploadEndpoint}`, { method: "POST", body: form, credentials: "include" });
      const data: unknown = await res.json();
      if (!res.ok || !isUploadResponse(data)) {
        throw new Error(getApiError(data, "Failed to parse file"));
      }
      setUploadData(data);
      setMapping(data.suggestedMapping);
      setStep(1);
    } catch (error) {
      toast({
        title: "Couldn't read this file",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleValidate = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mapping", JSON.stringify(mapping));
      for (const [k, v] of Object.entries(extraValues)) form.append(k, v);
      const res = await fetch(`${base}${validateEndpoint}`, { method: "POST", body: form, credentials: "include" });
      const data: unknown = await res.json();
      if (!res.ok || !isValidationResponse(data)) {
        throw new Error(getApiError(data, "Validation failed"));
      }
      setValidation(data);
      setStep(2);
    } catch (error) {
      toast({
        title: "Validation failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mapping", JSON.stringify(mapping));
      for (const [k, v] of Object.entries(extraValues)) form.append(k, v);
      const res = await fetch(`${base}${confirmEndpoint}`, { method: "POST", body: form, credentials: "include" });
      const data: unknown = await res.json();
      if (!res.ok || !isConfirmResponse(data)) {
        throw new Error(getApiError(data, "Failed to start import"));
      }
      setJobId(data.jobId);
      setStep(3);
      pollProgress(data.jobId);
    } catch (error) {
      toast({
        title: "Failed to start import",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const pollProgress = (jid: string) => {
    const evtSource = new EventSource(`${base}/api/imports/progress/${jid}`, { withCredentials: true });
    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data as string) as ProgressEvent;
      setProgress(data);
      if (data.status === "completed" || data.status === "failed") {
        evtSource.close();
        qc.invalidateQueries({ queryKey: ["imports", "history"] });
        if (data.status === "completed") toast({ title: "Import completed!", description: `${data.processed} rows processed, ${data.errorCount} errors.` });
        else toast({ title: "Import failed", variant: "destructive" });
      }
    };
    evtSource.onerror = () => evtSource.close();
  };

  const reset = () => { setStep(0); setFile(null); setUploadData(null); setMapping({}); setValidation(null); setJobId(null); setProgress(null); setExtraValues(initialExtraValues); };

  return (
    <div>
      <StepIndicator steps={steps} current={step} />

      {/* Step 0: Upload */}
      {step === 0 && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-lg">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer border-border hover:border-accent hover:bg-accent/5 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
            >
              {loading ? (
                <RefreshCcw className="h-10 w-10 text-accent animate-spin mx-auto mb-3" />
              ) : (
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-accent"><Upload className="h-7 w-7" /></div>
              )}
              <p className="font-medium">Drop your CSV file here or click to browse</p>
              <p className="text-sm text-muted-foreground mt-1">Supports CSV files up to 50MB</p>
              <input ref={fileInputRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 1: Field Mapping */}
      {step === 1 && uploadData && (
        <div className="space-y-4">
          <Card className="rounded-xl shadow-sm">
            <CardHeader>
              <CardTitle className="font-display text-lg">Map Fields</CardTitle>
              <CardDescription>
                File: <span className="font-medium">{file?.name}</span> · {uploadData.totalRows.toLocaleString()} rows detected
              </CardDescription>
            </CardHeader>
            <CardContent>
              {uploadData.parseIssues && uploadData.parseIssues.length > 0 && (
                <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
                  <p className="font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" />
                    {uploadData.parseIssues.length} row{uploadData.parseIssues.length === 1 ? "" : "s"} had formatting problems
                  </p>
                  <p className="mt-1 text-yellow-800">
                    The rest of the file is fine. You'll see exactly which rows and why on the next step.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {uploadData.headers.map((header) => (
                  <div key={header} className="flex items-center gap-3">
                    <span className="text-sm font-medium w-40 truncate">{header}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    <Select
                      value={mapping[header] || SKIP_FIELD_VALUE}
                      onValueChange={(v) => setMapping((m) => ({
                        ...m,
                        [header]: v === SKIP_FIELD_VALUE ? "" : v,
                      }))}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="— Skip field —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP_FIELD_VALUE}>— Skip field —</SelectItem>
                        {uploadData.targetFields.map((f) => (
                          <SelectItem key={f.field} value={f.field}>{f.label}{f.required ? " *" : ""}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {uploadData.sampleRows.length > 0 && (
                <div className="mt-6">
                  <p className="text-sm font-medium mb-2 text-muted-foreground">Preview (first 3 rows)</p>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="text-xs w-full">
                      <thead><tr className="bg-muted/50">{uploadData.headers.map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>)}</tr></thead>
                      <tbody>
                        {uploadData.sampleRows.slice(0, 3).map((row, i) => (
                          <tr key={i} className="border-t">{uploadData.headers.map((h) => <td key={h} className="px-3 py-2 text-muted-foreground truncate max-w-32">{row[h] ?? ""}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {extraConfirmFields?.map((f) => (
                <div key={f.key} className="mt-4 flex items-center gap-3">
                  <Label className="text-sm font-medium w-40">{f.label}</Label>
                  <Select value={extraValues[f.key] ?? ""} onValueChange={(v) => setExtraValues((ev) => ({ ...ev, [f.key]: v }))}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
          </Card>
          <div className="flex gap-3">
            <Button variant="outline" onClick={reset}>Start Over</Button>
            <Button onClick={handleValidate} disabled={loading}>
              {loading ? <RefreshCcw className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Validate {uploadData.totalRows.toLocaleString()} Rows
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Validate */}
      {step === 2 && validation && (
        <div className="space-y-4">
          <div className={`grid gap-4 ${validation.warningCount !== undefined ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"}`}>
            <Card className="rounded-xl shadow-sm">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Total Rows</p>
                <p className="font-display text-2xl font-bold">{validation.totalRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card className="rounded-xl shadow-sm">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Valid Rows</p>
                <p className="font-display text-2xl font-bold text-success">{validation.validRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card className="rounded-xl shadow-sm">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Errors</p>
                <p className={`font-display text-2xl font-bold ${validation.errorCount > 0 ? "text-destructive" : "text-success"}`}>{validation.errorCount.toLocaleString()}</p>
              </CardContent>
            </Card>
            {validation.warningCount !== undefined && (
              <Card className="rounded-xl shadow-sm">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Warnings</p>
                  <p className="font-display text-2xl font-bold text-warning">{validation.warningCount.toLocaleString()}</p>
                </CardContent>
              </Card>
            )}
          </div>

          {(validation.duplicateCount !== undefined || validation.enrollmentCount !== undefined) && (
            <p className="text-sm text-muted-foreground">
              {validation.enrollmentCount !== undefined && <>{validation.enrollmentCount.toLocaleString()} rows include plan coverage. </>}
              {validation.duplicateCount !== undefined && <>{validation.duplicateCount.toLocaleString()} rows match people already in agencyBRIDGE.</>}
            </p>
          )}

          {validation.errors.length > 0 && (
            <Card className="rounded-xl shadow-sm">
              <CardHeader>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  Row Issues (showing {Math.min(validation.errors.length, 200)})
                </CardTitle>
                <CardDescription>
                  Rows marked <strong>Error</strong> will be skipped. Rows marked <strong>Warning</strong> will still import — just check the note. Everything else imports normally.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Row</TableHead><TableHead>Type</TableHead><TableHead>Field</TableHead><TableHead>Issue</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {validation.errors.slice(0, 200).map((e, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{e.row > 0 ? e.row : "—"}</TableCell>
                          <TableCell>
                            {e.severity === "warning"
                              ? <StatusPill tone="warning">Warning</StatusPill>
                              : <StatusPill tone="danger">Error</StatusPill>}
                          </TableCell>
                          <TableCell><StatusPill tone="neutral">{e.field}</StatusPill></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{e.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep(1)}>Back to Mapping</Button>
            <Button onClick={handleConfirm} disabled={loading || validation.validRows === 0}>
              {loading ? <RefreshCcw className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
              Import {validation.validRows.toLocaleString()} Valid Rows
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Progress */}
      {step === 3 && (
        <Card className="rounded-xl shadow-sm">
          <CardContent className="p-8 text-center">
            {progress?.status === "completed" ? (
              <div className="space-y-4">
                <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
                <h3 className="font-display text-xl font-bold">Import Completed!</h3>
                <p className="text-muted-foreground">{progress.processed.toLocaleString()} rows processed · {progress.errorCount} errors</p>
                <Button onClick={reset}>Start New Import</Button>
              </div>
            ) : progress?.status === "failed" ? (
              <div className="space-y-4">
                <AlertTriangle className="h-16 w-16 text-destructive mx-auto" />
                <h3 className="font-display text-xl font-bold">Import Failed</h3>
                <Button onClick={reset}>Try Again</Button>
              </div>
            ) : (
              <div className="space-y-4">
                <RefreshCcw className="h-16 w-16 text-accent animate-spin mx-auto" />
                <h3 className="font-display text-xl font-bold">Importing…</h3>
                <Progress value={progress ? (progress.processed / Math.max(progress.total, 1)) * 100 : 0} className="h-3 max-w-sm mx-auto" />
                <p className="text-muted-foreground text-sm">
                  {progress ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} rows` : "Starting…"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Needed for Label in the ImportWizard
function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <label className={className}>{children}</label>;
}

// ─── GoHighLevel live sync ─────────────────────────────────────────────────────
type GhlStatus = {
  configured: boolean;
  locationId: string | null;
  running: boolean;
  backfillCompletedAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRun: { created: number; updated: number; skipped: number; failed?: number } | null;
};

function GhlLiveSyncCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: status, isLoading } = useQuery({
    queryKey: ["integrations", "ghl", "status"],
    queryFn: () => apiFetch<GhlStatus>("/api/integrations/ghl/status"),
    refetchInterval: 15_000,
  });
  const [busy, setBusy] = useState(false);

  const trigger = async (full: boolean) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ alreadyRunning?: boolean }>("/api/integrations/ghl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full }),
      });
      if (res?.alreadyRunning) {
        toast({
          title: full ? "Full re-sync scheduled" : "A sync is already running",
          description: full
            ? "It will start as soon as the sync in progress finishes."
            : "It is picking up new and changed contacts now; anything after it will be picked up within 15 minutes.",
        });
      } else {
        toast({ title: full ? "Full re-sync started" : "Sync started", description: "New and changed GoHighLevel contacts will appear shortly." });
      }
      void qc.invalidateQueries({ queryKey: ["integrations", "ghl", "status"] });
    } catch (error) {
      toast({ title: "Couldn't start sync", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !status) return <Skeleton className="h-28 rounded-xl mb-6" />;

  return (
    <Card className="mb-6 rounded-xl shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <RefreshCcw className={`h-5 w-5 text-accent ${status.running ? "animate-spin" : ""}`} />
          GoHighLevel live sync
          {status.configured
            ? <StatusPill tone="success">Connected</StatusPill>
            : <StatusPill tone="neutral">Not connected</StatusPill>}
        </CardTitle>
        <CardDescription>
          {status.configured
            ? "New and updated GoHighLevel contacts are pulled in automatically every 15 minutes. Existing agencyBRIDGE data is never overwritten — only blank fields are filled."
            : "Ask your administrator to add your GoHighLevel Private Integration token and location id to turn on automatic syncing. You can still import a CSV export below."}
        </CardDescription>
      </CardHeader>
      {status.configured && (
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {status.running ? "Syncing now…"
              : status.lastRunAt ? <>Last sync {new Date(status.lastRunAt).toLocaleString()}
                  {status.lastRun && <> · {status.lastRun.created} added, {status.lastRun.updated} updated, {status.lastRun.skipped} skipped{status.lastRun.failed ? ` (${status.lastRun.failed} couldn't be saved)` : ""}</>}</>
              : "Not synced yet."}
            {!status.backfillCompletedAt && status.lastRunAt && !status.running && <> · first full pull still in progress</>}
          </div>
          {status.lastStatus === "error" && status.lastError && (
            <p className="text-sm text-destructive flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{status.lastError}</p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => trigger(false)} disabled={busy || status.running}>Sync now</Button>
            <Button size="sm" variant="outline" onClick={() => trigger(true)} disabled={busy || status.running}>Re-sync everything</Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Import History ────────────────────────────────────────────────────────────
function ImportHistoryTab() {
  const { data: jobs, isLoading } = useQuery({
    queryKey: ["imports", "history"],
    queryFn: () => apiFetch<ImportJob[]>("/api/imports/history"),
  });

  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const TYPE_LABELS: Record<string, string> = {
    monday_com: "Monday.com",
    gohighlevel: "GoHighLevel",
    csv_contacts: "CSV Contacts",
    csv_agents: "CSV Agents",
  };

  return (
    <SectionCard title="Import history" description="Every import your agency has run, with a download of any rows that had problems" icon={History}>
      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded" />)}</div>
      ) : jobs && jobs.length === 0 ? (
        <EmptyState
          icon={History}
          title="No imports yet"
          description="When you bring in agents or clients from Monday.com, GoHighLevel or a spreadsheet, each import is listed here."
        />
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs?.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(job.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell><StatusPill tone="navy">{TYPE_LABELS[job.importType] ?? job.importType}</StatusPill></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-32 truncate">{job.fileName ?? "—"}</TableCell>
                  <TableCell>
                    <StatusPill status={job.status} />
                  </TableCell>
                  <TableCell className="text-sm">{job.totalRows.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-success font-medium">{job.createdCount.toLocaleString()}</TableCell>
                  <TableCell className="text-sm">
                    {job.errorCount > 0
                      ? <span className="text-destructive font-medium">{job.errorCount.toLocaleString()}</span>
                      : <span className="text-muted-foreground">0</span>
                    }
                    {(job.warningCount ?? 0) > 0 && (
                      <span className="block text-xs text-yellow-700">{job.warningCount!.toLocaleString()} warning{job.warningCount === 1 ? "" : "s"}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {(job.errorCount > 0 || (job.warningCount ?? 0) > 0) && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                        <a href={`${base}/api/imports/${job.id}/errors.csv`} download>
                          <Download className="h-3.5 w-3.5 mr-1" /> Errors
                        </a>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {jobs?.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No import jobs found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function DataMigrationPage() {
  const { data: me } = useGetMe();

  if (me && !["super_admin", "agency_admin"].includes(me.role)) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState icon={Database} title="Only admins can access data migration." description="Ask an agency admin to run imports for you." />
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Import & Migration"
        subtitle="Bring your agents and clients over from Monday.com, GoHighLevel or any spreadsheet — check everything before it's saved"
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: Upload, title: "1. Upload", text: "Drop in a CSV export from your old system." },
          { icon: ArrowRight, title: "2. Match & check", text: "Line up your columns and see any problem rows first." },
          { icon: CheckCircle2, title: "3. Import", text: "Only valid rows are saved. Medicare IDs are encrypted." },
        ].map((s) => (
          <div key={s.title} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
              <s.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="font-display font-semibold text-sm">{s.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.text}</p>
            </div>
          </div>
        ))}
      </div>

      <Tabs defaultValue="monday">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="monday" className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" /> Monday.com (Agents)
          </TabsTrigger>
          <TabsTrigger value="ghl" className="flex items-center gap-1.5">
            <FileSpreadsheet className="h-3.5 w-3.5" /> GoHighLevel (Contacts)
          </TabsTrigger>
          <TabsTrigger value="csv" className="flex items-center gap-1.5">
            <Upload className="h-3.5 w-3.5" /> Generic CSV (Contacts)
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" /> Import History
          </TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="monday">
            <ImportWizard
              title="Import Agents from Monday.com"
              description="Upload your Monday.com board export CSV. agencyBRIDGE will auto-detect common column names and import agents with their license states and tasks."
              uploadEndpoint="/api/imports/monday/upload"
              validateEndpoint="/api/imports/monday/validate"
              confirmEndpoint="/api/imports/monday/confirm"
            />
          </TabsContent>

          <TabsContent value="ghl">
            <GhlLiveSyncCard />
            <ImportWizard
              title="Import Contacts from GoHighLevel"
              description="Upload your GoHighLevel contacts export CSV. agencyBRIDGE supports duplicate detection and can merge, skip, or create contacts on collision."
              uploadEndpoint="/api/imports/ghl/upload"
              validateEndpoint="/api/imports/ghl/validate"
              confirmEndpoint="/api/imports/ghl/confirm"
              extraConfirmFields={[
                {
                  label: "On duplicate contact:",
                  key: "duplicateAction",
                  options: [
                    { value: "skip", label: "Skip duplicate" },
                    { value: "merge", label: "Merge fields" },
                    { value: "create_new", label: "Create new record" },
                  ],
                },
              ]}
            />
          </TabsContent>

          <TabsContent value="csv">
            <ImportWizard
              title="Import Contacts from CSV"
              description="Upload any CSV of clients — including Medicare ID, carrier, plan, and effective date. Rows with plan details also create an enrollment. Medicare IDs are encrypted before they are stored."
              uploadEndpoint="/api/imports/contacts/upload"
              validateEndpoint="/api/imports/contacts/validate"
              confirmEndpoint="/api/imports/contacts/confirm"
              extraConfirmFields={[
                {
                  label: "If the person already exists:",
                  key: "duplicateAction",
                  defaultValue: "merge",
                  options: [
                    { value: "merge", label: "Fill in blanks + add coverage" },
                    { value: "skip", label: "Skip the row" },
                    { value: "create_new", label: "Create a separate contact" },
                  ],
                },
              ]}
            />
          </TabsContent>

          <TabsContent value="history">
            <ImportHistoryTab />
          </TabsContent>
        </div>
      </Tabs>
    </PageShell>
  );
}
