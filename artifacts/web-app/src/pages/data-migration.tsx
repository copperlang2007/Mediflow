import { useState, useRef } from "react";
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
import { useToast } from "@/hooks/use-toast";
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  ArrowRight, History, Download, RefreshCcw, Database,
  Layers,
} from "lucide-react";

type TargetField = { field: string; label: string; required?: boolean };
type UploadResponse = { headers: string[]; sampleRows: Record<string, string>[]; totalRows: number; suggestedMapping: Record<string, string>; targetFields: TargetField[] };
type ValidationResponse = { totalRows: number; errorCount: number; validRows: number; errors: { row: number; field: string; message: string }[] };
type ImportJob = { id: string; importType: string; status: string; totalRows: number; processedRows: number; createdCount: number; updatedCount: number; skippedCount: number; errorCount: number; fileName: string | null; createdAt: string; completedAt: string | null };
type ProgressEvent = { status: string; processed: number; total: number; errorCount: number };

// ─── Wizard Step Indicator ─────────────────────────────────────────────────────
function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold transition-colors ${i < current ? "bg-green-500 text-white" : i === current ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
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
  extraConfirmFields?: { label: string; key: string; options: { value: string; label: string }[] }[];
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
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const handleFileSelect = async (f: File) => {
    setFile(f);
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`${base}${uploadEndpoint}`, { method: "POST", body: form, credentials: "include" });
      const data = await res.json() as UploadResponse;
      setUploadData(data);
      setMapping(data.suggestedMapping);
      setStep(1);
    } catch {
      toast({ title: "Failed to parse file", variant: "destructive" });
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
      const res = await fetch(`${base}${validateEndpoint}`, { method: "POST", body: form, credentials: "include" });
      const data = await res.json() as ValidationResponse;
      setValidation(data);
      setStep(2);
    } catch {
      toast({ title: "Validation failed", variant: "destructive" });
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
      const data = await res.json() as { jobId: string; totalRows: number };
      setJobId(data.jobId);
      setStep(3);
      pollProgress(data.jobId);
    } catch {
      toast({ title: "Failed to start import", variant: "destructive" });
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

  const reset = () => { setStep(0); setFile(null); setUploadData(null); setMapping({}); setValidation(null); setJobId(null); setProgress(null); };

  return (
    <div>
      <StepIndicator steps={steps} current={step} />

      {/* Step 0: Upload */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
            >
              {loading ? (
                <RefreshCcw className="h-10 w-10 text-blue-500 animate-spin mx-auto mb-3" />
              ) : (
                <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              )}
              <p className="font-medium">Drop your CSV file here or click to browse</p>
              <p className="text-sm text-muted-foreground mt-1">Supports CSV files up to 50MB</p>
              <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 1: Field Mapping */}
      {step === 1 && uploadData && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Map Fields</CardTitle>
              <CardDescription>
                File: <span className="font-medium">{file?.name}</span> · {uploadData.totalRows.toLocaleString()} rows detected
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {uploadData.headers.map((header) => (
                  <div key={header} className="flex items-center gap-3">
                    <span className="text-sm font-medium w-40 truncate">{header}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    <Select value={mapping[header] ?? ""} onValueChange={(v) => setMapping((m) => ({ ...m, [header]: v }))}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="— Skip field —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">— Skip field —</SelectItem>
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
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Total Rows</p>
                <p className="text-2xl font-bold">{validation.totalRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Valid Rows</p>
                <p className="text-2xl font-bold text-green-600">{validation.validRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Errors</p>
                <p className={`text-2xl font-bold ${validation.errorCount > 0 ? "text-red-500" : "text-green-600"}`}>{validation.errorCount.toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          {validation.errors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                  Validation Errors (first {validation.errors.length})
                </CardTitle>
                <CardDescription>These rows will be skipped. Valid rows will still be imported.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Row</TableHead><TableHead>Field</TableHead><TableHead>Issue</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {validation.errors.slice(0, 50).map((e, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{e.row}</TableCell>
                          <TableCell><Badge variant="secondary" className="text-xs">{e.field}</Badge></TableCell>
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
        <Card>
          <CardContent className="p-8 text-center">
            {progress?.status === "completed" ? (
              <div className="space-y-4">
                <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
                <h3 className="text-xl font-bold">Import Completed!</h3>
                <p className="text-muted-foreground">{progress.processed.toLocaleString()} rows processed · {progress.errorCount} errors</p>
                <Button onClick={reset}>Start New Import</Button>
              </div>
            ) : progress?.status === "failed" ? (
              <div className="space-y-4">
                <AlertTriangle className="h-16 w-16 text-red-500 mx-auto" />
                <h3 className="text-xl font-bold">Import Failed</h3>
                <Button onClick={reset}>Try Again</Button>
              </div>
            ) : (
              <div className="space-y-4">
                <RefreshCcw className="h-16 w-16 text-blue-500 animate-spin mx-auto" />
                <h3 className="text-xl font-bold">Importing…</h3>
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">All past import jobs for your organization.</p>
      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded" />)}</div>
      ) : (
        <Card>
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
                  <TableCell><Badge variant="secondary" className="text-xs">{TYPE_LABELS[job.importType] ?? job.importType}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-32 truncate">{job.fileName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={job.status === "completed" ? "default" : job.status === "failed" ? "destructive" : "secondary"}
                      className={`text-xs ${job.status === "completed" ? "bg-green-100 text-green-800" : ""}`}>
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{job.totalRows.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-green-600">{job.createdCount.toLocaleString()}</TableCell>
                  <TableCell className="text-sm">
                    {job.errorCount > 0
                      ? <span className="text-red-500">{job.errorCount.toLocaleString()}</span>
                      : <span className="text-muted-foreground">0</span>
                    }
                  </TableCell>
                  <TableCell>
                    {job.errorCount > 0 && (
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
        </Card>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function DataMigrationPage() {
  const { data: me } = useGetMe();

  if (me && !["super_admin", "agency_admin"].includes(me.role)) {
    return <div className="p-8 text-center text-muted-foreground">Only admins can access data migration.</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Database className="h-6 w-6 text-blue-600" />
          Data Migration
        </h1>
        <p className="text-muted-foreground mt-1">Import agents from Monday.com, contacts from GoHighLevel, or upload any CSV.</p>
      </div>

      <Tabs defaultValue="monday">
        <TabsList>
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
              description="Upload your Monday.com board export CSV. MediFlow will auto-detect common column names and import agents with their license states and tasks."
              uploadEndpoint="/api/imports/monday/upload"
              validateEndpoint="/api/imports/monday/validate"
              confirmEndpoint="/api/imports/monday/confirm"
            />
          </TabsContent>

          <TabsContent value="ghl">
            <ImportWizard
              title="Import Contacts from GoHighLevel"
              description="Upload your GoHighLevel contacts export CSV. MediFlow supports duplicate detection and can merge, skip, or create contacts on collision."
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
              description="Upload any CSV with contact data. Map your columns to MediFlow fields. All contacts will be imported as leads."
              uploadEndpoint="/api/imports/contacts/upload"
              validateEndpoint="/api/imports/contacts/validate"
              confirmEndpoint="/api/imports/contacts/confirm"
            />
          </TabsContent>

          <TabsContent value="history">
            <ImportHistoryTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
