import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart2, TrendingUp, Users, MessageSquare,
  ShieldCheck, RefreshCcw, Download, AlertTriangle,
  CheckCircle2, XCircle, Printer, DollarSign, Activity,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { PageHeader, SectionCard, StatusPill, EmptyState as SharedEmptyState } from "@/components/shared";
import { PageShell, NoticeBanner } from "@/components/ops";
import { FileSpreadsheet, Play, Lock } from "lucide-react";

const COLORS = ["#3b6fa0", "#22a05a", "#f59e0b", "#dc2626", "#1e3a5f", "#8db3d9"];

// ─── Report library ───────────────────────────────────────────────────────────
// One row per real CSV export the API offers. "Run" downloads it straight
// away for the chosen window — nothing here is scheduled or simulated.
type LibraryReport = {
  key: string;
  title: string;
  description: string;
  columns: string[];
  path: (range: { start: string; end: string }) => string;
  file: string;
  dated: boolean;
};

const LIBRARY: LibraryReport[] = [
  {
    key: "executive",
    title: "Executive summary",
    description: "Agents, leads, deals won, pipeline value and AHIP pass rate for the period",
    columns: ["Agents", "Leads", "Deals won", "Won value", "AHIP rate"],
    path: (r) => `/api/reports/executive/export?startDate=${r.start}&endDate=${r.end}`,
    file: "executive-report.csv",
    dated: true,
  },
  {
    key: "agent-performance",
    title: "Agent production",
    description: "Contacts worked, calls, deals won and compliance score per agent",
    columns: ["Agent", "Deals won", "Enrolled", "Compliance", "AHIP"],
    path: (r) => `/api/reports/agent-performance/export?startDate=${r.start}&endDate=${r.end}`,
    file: "agent-performance.csv",
    dated: true,
  },
  {
    key: "pipeline",
    title: "Pipeline & win rate",
    description: "Deals in each stage, won and lost, per pipeline",
    columns: ["Pipeline", "Stage", "Deals", "Won", "Lost"],
    path: (r) => `/api/reports/pipeline/export?startDate=${r.start}&endDate=${r.end}`,
    file: "pipeline-report.csv",
    dated: true,
  },
  {
    key: "leads",
    title: "Lead sources",
    description: "Where leads came from and how many converted and enrolled",
    columns: ["Source", "Leads", "Converted", "Enrolled"],
    path: (r) => `/api/reports/leads/export?startDate=${r.start}&endDate=${r.end}`,
    file: "leads-report.csv",
    dated: true,
  },
  {
    key: "compliance-matrix",
    title: "Compliance status",
    description: "Every agent's licenses by state, what's expiring, and carrier certifications",
    columns: ["Agent", "State", "License", "Expiry", "Status"],
    path: () => "/api/reports/compliance-matrix/export",
    file: "compliance-matrix.csv",
    dated: false,
  },
  {
    key: "communications",
    title: "Communications",
    description: "SMS and email sent, AI-assisted messages and opt-outs",
    columns: ["Agent", "SMS", "Email", "AI-assisted"],
    path: (r) => `/api/reports/communications/export?startDate=${r.start}&endDate=${r.end}`,
    file: "communications-report.csv",
    dated: true,
  },
  {
    key: "retention",
    title: "Retention & churn",
    description: "Enrolled, at-risk and lost members, and re-enrollment opportunities",
    columns: ["Enrolled", "At risk", "Lost", "Retention rate"],
    path: () => "/api/reports/retention/export",
    file: "retention-report.csv",
    dated: false,
  },
];

function ReportLibrary() {
  const [range, setRange] = useState({ start: dateOffset(30), end: today() });
  const [running, setRunning] = useState<string | null>(null);

  const run = async (r: LibraryReport) => {
    setRunning(r.key);
    try {
      await downloadCsv(r.path(range), r.file);
    } finally {
      setRunning(null);
    }
  };

  return (
    <SectionCard
      title="Report library"
      description="Download any report as a spreadsheet. Dated reports use the window you pick here."
      icon={FileSpreadsheet}
      actions={<DateRangePicker value={range} onChange={setRange} />}
    >
      <div className="space-y-3">
        {LIBRARY.map((r) => (
          <div key={r.key} className="flex flex-col gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
              <BarChart2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">{r.title}</p>
              <p className="text-xs text-muted-foreground">{r.description}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.columns.map((c) => (
                  <span key={c} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{c}</span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusPill tone={r.dated ? "info" : "neutral"}>{r.dated ? "Date range" : "Right now"}</StatusPill>
              <StatusPill tone="navy">CSV</StatusPill>
              <Button variant="outline" size="sm" onClick={() => void run(r)} disabled={running === r.key}>
                {running === r.key ? <RefreshCcw className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
                Run
              </Button>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function DateRangePicker({ value, onChange }: { value: { start: string; end: string }; onChange: (v: { start: string; end: string }) => void }) {
  const presets = [
    { label: "Last 30 days", days: 30 },
    { label: "Last 60 days", days: 60 },
    { label: "Last 90 days", days: 90 },
    { label: "Last 6 months", days: 180 },
    { label: "Last year", days: 365 },
  ];
  return (
    <Select
      onValueChange={(d) => {
        const end = new Date();
        const start = new Date(end.getTime() - parseInt(d) * 24 * 60 * 60 * 1000);
        onChange({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
      }}
      defaultValue="30"
    >
      <SelectTrigger className="w-40 bg-card">
        <SelectValue placeholder="Date range" />
      </SelectTrigger>
      <SelectContent>
        {presets.map((p) => (
          <SelectItem key={p.days} value={String(p.days)}>{p.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Agent Performance ────────────────────────────────────────────────────────
function AgentPerformanceTab() {
  const [range, setRange] = useState({ start: dateOffset(30), end: today() });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", "agent-performance", range],
    queryFn: () => apiFetch<AgentPerfRow[]>(`/api/reports/agent-performance?startDate=${range.start}&endDate=${range.end}`),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data?.length) return <EmptyState message="No agent data available for the selected period." />;

  const sorted = [...data].sort((a, b) => b.dealsWon - a.dealsWon);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <DateRangePicker value={range} onChange={setRange} />
        <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/reports/agent-performance/export?startDate=${range.start}&endDate=${range.end}`, "agent-performance.csv")}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Total Agents" value={data.length} icon={<Users className="h-5 w-5 text-accent" />} />
        <StatCard title="Total Deals Won" value={data.reduce((s, r) => s + r.dealsWon, 0)} icon={<TrendingUp className="h-5 w-5 text-success" />} />
        <StatCard title="Avg Compliance Score" value={`${Math.round(data.reduce((s, r) => s + r.complianceScore, 0) / data.length)}%`} icon={<ShieldCheck className="h-5 w-5 text-navy-700 dark:text-accent" />} />
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader>
          <CardTitle className="font-display text-lg">Deals Won by Agent</CardTitle>
          <CardDescription>Top performing agents in the selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sorted.slice(0, 15)}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="agentName" tick={{ fontSize: 11 }} tickFormatter={(v) => v.split(" ")[0]} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="dealsWon" fill="#3b6fa0" radius={[4, 4, 0, 0]} name="Deals Won" />
              <Bar dataKey="enrolledContacts" fill="#22a05a" radius={[4, 4, 0, 0]} name="Enrolled" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="rounded-xl shadow-sm">
        <CardHeader><CardTitle className="font-display text-lg">Compliance Score by Agent</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {sorted.slice(0, 20).map((agent) => (
              <div key={agent.agentId} className="flex items-center gap-3">
                <span className="text-sm w-36 truncate text-muted-foreground">{agent.agentName}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${agent.complianceScore >= 75 ? "bg-success" : agent.complianceScore >= 50 ? "bg-warning" : "bg-destructive"}`}
                    style={{ width: `${agent.complianceScore}%` }}
                  />
                </div>
                <span className="text-sm font-medium w-10 text-right">{agent.complianceScore}%</span>
                <StatusPill tone={agent.ahipStatus === "passed" ? "success" : "neutral"} className="w-20 justify-center">
                  {agent.ahipStatus === "passed" ? "AHIP done" : "No AHIP"}
                </StatusPill>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Pipeline Report ──────────────────────────────────────────────────────────
function PipelineTab() {
  const [range, setRange] = useState({ start: dateOffset(90), end: today() });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", "pipeline", range],
    queryFn: () => apiFetch<PipelineReportRow[]>(`/api/reports/pipeline?startDate=${range.start}&endDate=${range.end}`),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data?.length) return <EmptyState message="No pipeline data available." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/reports/pipeline/export?startDate=${range.start}&endDate=${range.end}`, "pipeline-report.csv")}>
            <Download className="h-4 w-4 mr-1.5" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-1.5" /> Print
          </Button>
        </div>
      </div>

      {data.map((pipeline) => (
        <Card key={pipeline.pipelineId} className="rounded-xl shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="font-display text-lg">{pipeline.pipelineName}</CardTitle>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Win Rate: <span className="font-semibold text-foreground">{pipeline.winRate}%</span></span>
                <span>Won Value: <span className="font-semibold text-success">${pipeline.totalWonValue.toLocaleString()}</span></span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-3 bg-muted/50 rounded-lg"><p className="text-2xl font-bold">{pipeline.totalDeals}</p><p className="text-xs text-muted-foreground">Total Deals</p></div>
              <div className="p-3 bg-success/10 rounded-lg"><p className="font-display text-2xl font-bold text-success">{pipeline.wonDeals}</p><p className="text-xs text-muted-foreground">Won</p></div>
              <div className="p-3 bg-destructive/10 rounded-lg"><p className="font-display text-2xl font-bold text-destructive">{pipeline.lostDeals}</p><p className="text-xs text-muted-foreground">Lost</p></div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={pipeline.funnel}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="stageName" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="dealCount" fill="#3b6fa0" radius={[4, 4, 0, 0]} name="Active" />
                <Bar dataKey="wonCount" fill="#22a05a" radius={[4, 4, 0, 0]} name="Won" />
                <Bar dataKey="lostCount" fill="#dc2626" radius={[4, 4, 0, 0]} name="Lost" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Leads Report ─────────────────────────────────────────────────────────────
function LeadsTab() {
  const [range, setRange] = useState({ start: dateOffset(90), end: today() });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", "leads", range],
    queryFn: () => apiFetch<LeadsReport>(`/api/reports/leads?startDate=${range.start}&endDate=${range.end}`),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState message="No lead data available." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/reports/leads/export?startDate=${range.start}&endDate=${range.end}`, "leads-report.csv")}>
            <Download className="h-4 w-4 mr-1.5" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-1.5" /> Print
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard title="Total Leads" value={data.totalLeads} icon={<Users className="h-5 w-5 text-accent" />} />
        <StatCard title="Converted Leads" value={data.convertedLeads} subtitle={data.totalLeads > 0 ? `${Math.round((data.convertedLeads / data.totalLeads) * 100)}% conversion` : undefined} icon={<TrendingUp className="h-5 w-5 text-success" />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Leads by Source</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={data.sourceBreakdown} cx="50%" cy="50%" outerRadius={90} dataKey="total" nameKey="source" label={({ source, percent }) => `${source} ${(percent * 100).toFixed(0)}%`}>
                  {data.sourceBreakdown.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Weekly Lead Volume</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#3b6fa0" strokeWidth={2} dot={false} name="Leads" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader><CardTitle className="font-display text-lg">Source Breakdown Detail</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Source</th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">Leads</th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">Converted</th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">Conv. Rate</th>
                  <th className="text-right py-2 pl-4 font-medium text-muted-foreground">Enrolled</th>
                </tr>
              </thead>
              <tbody>
                {data.sourceBreakdown.map((row) => (
                  <tr key={row.source} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2 pr-4 font-medium">{row.source}</td>
                    <td className="text-right py-2 px-4">{row.total.toLocaleString()}</td>
                    <td className="text-right py-2 px-4">{row.converted.toLocaleString()}</td>
                    <td className="text-right py-2 px-4">
                      <Badge variant={row.conversionRate >= 20 ? "default" : "secondary"}>{row.conversionRate}%</Badge>
                    </td>
                    <td className="text-right py-2 pl-4">{row.enrolled.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Compliance Matrix ────────────────────────────────────────────────────────
function ComplianceMatrixTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["reports", "compliance-matrix"],
    queryFn: () => apiFetch<ComplianceMatrixReport>("/api/reports/compliance-matrix"),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState message="No compliance data." />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={() => downloadCsv("/api/reports/compliance-matrix/export", "compliance-matrix.csv")}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-1.5" /> Print
        </Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-lg">AHIP Certification Trend</CardTitle>
            <CardDescription>Completion rate by year</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.ahipTrend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="passed" fill="#22a05a" radius={[4, 4, 0, 0]} name="Passed" />
                <Bar dataKey="total" fill="#cbd5e1" radius={[4, 4, 0, 0]} name="Total" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-lg">License Expiry Heatmap</CardTitle>
            <CardDescription>Licenses expiring by month</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.expiryByMonth}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Expiring Licenses" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader>
          <CardTitle className="font-display text-lg">Carrier Cert Completion by Carrier</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.carrierCertCompletion.slice(0, 10).map((carrier) => {
              const currentYear = carrier.byYear[0];
              if (!currentYear) return null;
              return (
                <div key={carrier.carrierId} className="flex items-center gap-3">
                  <span className="text-sm w-36 truncate">{carrier.carrierName}</span>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div className="h-2 rounded-full bg-navy-600 dark:bg-accent" style={{ width: `${currentYear.completionRate}%` }} />
                  </div>
                  <span className="text-sm font-medium w-12 text-right">{currentYear.completionRate}%</span>
                  <span className="text-xs text-muted-foreground w-20 text-right">{currentYear.passed}/{currentYear.total}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl shadow-sm">
        <CardHeader><CardTitle className="font-display text-lg">Agent License Matrix</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Agent</th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">Active Licenses</th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">Expiring Soon</th>
                  <th className="text-left py-2 pl-4 font-medium text-muted-foreground">States</th>
                </tr>
              </thead>
              <tbody>
                {data.licenseMatrix.slice(0, 20).map((agent: AgentLicenseRow) => {
                  const active = agent.licenses.filter((l) => l.status === "active").length;
                  const expiring = agent.licenses.filter((l) => l.expiringIn90Days).length;
                  return (
                    <tr key={agent.agentId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-4 font-medium">{agent.agentName}</td>
                      <td className="text-right py-2 px-4">{active}</td>
                      <td className="text-right py-2 px-4">
                        {expiring > 0 ? <Badge variant="destructive">{expiring}</Badge> : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="py-2 pl-4 flex flex-wrap gap-1">
                        {agent.licenses.slice(0, 6).map((l, i) => (
                          <Badge key={i} variant={l.status === "active" ? "default" : "secondary"} className="text-xs">{l.stateCode}</Badge>
                        ))}
                        {agent.licenses.length > 6 && <span className="text-xs text-muted-foreground">+{agent.licenses.length - 6}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Communications Report ────────────────────────────────────────────────────
function CommunicationsTab() {
  const [range, setRange] = useState({ start: dateOffset(30), end: today() });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", "communications", range],
    queryFn: () => apiFetch<CommunicationsReport>(`/api/reports/communications?startDate=${range.start}&endDate=${range.end}`),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState message="No communications data." />;

  const deliveryRate = data.totalSms > 0 ? Math.round(((data.totalSms - (data.optOutSmsContacts ?? 0)) / data.totalSms) * 100) : 100;

  return (
    <div className="space-y-6 print:space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/reports/communications/export?startDate=${range.start}&endDate=${range.end}`, "communications-report.csv")}>
            <Download className="h-4 w-4 mr-1.5" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-1.5" /> Print
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="SMS Sent" value={data.totalSms.toLocaleString()} icon={<MessageSquare className="h-5 w-5 text-accent" />} />
        <StatCard title="Emails Sent" value={data.totalEmail.toLocaleString()} icon={<MessageSquare className="h-5 w-5 text-navy-700 dark:text-accent" />} />
        <StatCard title="AI-Assisted SMS" value={data.aiAssistedSms.toLocaleString()} subtitle={data.totalSms > 0 ? `${Math.round((data.aiAssistedSms / data.totalSms) * 100)}% AI-written` : undefined} icon={<TrendingUp className="h-5 w-5 text-success" />} />
        <StatCard title="AI-Assisted Email" value={data.aiAssistedEmail.toLocaleString()} subtitle={data.totalEmail > 0 ? `${Math.round((data.aiAssistedEmail / data.totalEmail) * 100)}% AI-written` : undefined} icon={<TrendingUp className="h-5 w-5 text-warning" />} />
      </div>

      {/* Delivery & opt-out metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          title="SMS Opt-outs"
          value={(data.optOutSmsContacts ?? 0).toLocaleString()}
          subtitle="Contacts opted out of SMS"
          icon={<XCircle className="h-5 w-5 text-destructive" />}
        />
        <StatCard
          title="Email Opt-outs"
          value={(data.optOutEmailContacts ?? 0).toLocaleString()}
          subtitle="Contacts opted out of email"
          icon={<XCircle className="h-5 w-5 text-destructive" />}
        />
        <StatCard
          title="Effective Delivery Rate"
          value={`${deliveryRate}%`}
          subtitle="SMS recipients not opted out"
          icon={<CheckCircle2 className="h-5 w-5 text-success" />}
        />
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader><CardTitle className="font-display text-lg">Weekly Volume Trend</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.trend}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="sms" stroke="#3b6fa0" strokeWidth={2} dot={false} name="SMS" />
              <Line type="monotone" dataKey="email" stroke="#1e3a5f" strokeWidth={2} dot={false} name="Email" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Per-agent leaderboard */}
      {data.byAgent && data.byAgent.length > 0 && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-lg">Agent Outreach Leaderboard</CardTitle>
            <CardDescription>SMS and email volume per agent in the selected period</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Agent</th>
                    <th className="text-right py-2 px-4 font-medium text-muted-foreground">SMS</th>
                    <th className="text-right py-2 px-4 font-medium text-muted-foreground">Email</th>
                    <th className="text-right py-2 pl-4 font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAgent.slice(0, 15).map((row) => (
                    <tr key={row.agentId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-4 font-medium">{row.agentName}</td>
                      <td className="text-right py-2 px-4">{row.smsSent.toLocaleString()}</td>
                      <td className="text-right py-2 px-4">{row.emailSent.toLocaleString()}</td>
                      <td className="text-right py-2 pl-4 font-semibold">{(row.smsSent + row.emailSent).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Retention Report ─────────────────────────────────────────────────────────
function RetentionTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["reports", "retention"],
    queryFn: () => apiFetch<RetentionReport>("/api/reports/retention"),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState message="No retention data." />;

  return (
    <div className="space-y-6 print:space-y-4">
      <div className="flex justify-end gap-2 print:hidden">
        <Button variant="outline" size="sm" onClick={() => downloadCsv("/api/reports/retention/export", "retention-report.csv")}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-1.5" /> Print
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Enrolled Members" value={data.enrolledContacts.toLocaleString()} icon={<CheckCircle2 className="h-5 w-5 text-success" />} />
        <StatCard title="At-Risk Members" value={data.atRiskContacts.toLocaleString()} subtitle="No activity 60+ days" icon={<AlertTriangle className="h-5 w-5 text-warning" />} />
        <StatCard title="Lost Members" value={data.lostContacts.toLocaleString()} icon={<XCircle className="h-5 w-5 text-destructive" />} />
        <StatCard
          title="Re-enrollment Opportunities"
          value={(data.reEnrollmentOpportunity ?? 0).toLocaleString()}
          subtitle="AEP-eligible lost members"
          icon={<TrendingUp className="h-5 w-5 text-accent" />}
        />
      </div>

      {/* AEP / OEP window banners */}
      {data.aepWindow?.isActive && (
        <NoticeBanner icon={AlertTriangle} title="Annual Enrollment Period (AEP) is active">
          {data.reEnrollmentOpportunity ?? 0} lost members are re-enrollment candidates. Consider outreach sequences now.
        </NoticeBanner>
      )}

      {data.upcomingBirthdays != null && data.upcomingBirthdays > 0 && (
        <NoticeBanner icon={CheckCircle2} tone="success" title={`${data.upcomingBirthdays} member(s) turning 65 in the next 90 days`}>
          These contacts qualify for Medicare Part B enrollment — consider a targeted outreach campaign.
        </NoticeBanner>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Retention Rate</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center justify-center h-48">
            <div className="font-display text-6xl font-bold text-success">{data.retentionRate}%</div>
            <p className="text-muted-foreground mt-2">Overall member retention</p>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Member Status Breakdown</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={[
                    { name: "Enrolled", value: data.enrolledContacts },
                    { name: "At Risk", value: data.atRiskContacts },
                    { name: "Lost", value: data.lostContacts },
                  ]}
                  cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value"
                >
                  <Cell fill="#22a05a" />
                  <Cell fill="#f59e0b" />
                  <Cell fill="#dc2626" />
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Monthly enrollment / loss trend */}
      {data.monthlyTrend && data.monthlyTrend.length > 0 && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-lg">Monthly Enrollment Trend</CardTitle>
            <CardDescription>New enrollments vs. members lost over the past 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="enrolled" fill="#22a05a" radius={[4, 4, 0, 0]} name="Enrolled" />
                <Bar dataKey="lost" fill="#dc2626" radius={[4, 4, 0, 0]} name="Lost" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {data.atRiskRate > 10 && (
        <NoticeBanner icon={AlertTriangle} tone="warning" title={`${data.atRiskRate}% of enrolled members are at risk`}>
          Consider running a re-engagement sequence for members with no activity in the past 60 days.
        </NoticeBanner>
      )}
    </div>
  );
}

// ─── Executive KPI Tab ────────────────────────────────────────────────────────
function ExecutiveTab() {
  const [range, setRange] = useState({ start: dateOffset(30), end: today() });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", "executive", range],
    queryFn: () => apiFetch<ExecutiveReport>(`/api/reports/executive?startDate=${range.start}&endDate=${range.end}`),
  });

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState message="No executive data available." />;

  const leadsTrend = data.leads.changePercent;

  return (
    <div className="space-y-6 print:space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/reports/executive/export?startDate=${range.start}&endDate=${range.end}`, "executive-report.csv")}>
            <Download className="h-4 w-4 mr-1.5" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4 mr-1.5" /> Print</Button>
        </div>
      </div>

      {/* Section: Agency Workforce */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Workforce</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Active Agents" value={data.agents.active} icon={<Users className="h-5 w-5 text-accent" />} />
          <StatCard title="In Onboarding" value={data.agents.onboarding} icon={<Activity className="h-5 w-5 text-warning" />} />
          <StatCard title="Enrolled Members" value={data.members.enrolled.toLocaleString()} icon={<ShieldCheck className="h-5 w-5 text-success" />} />
          <StatCard title="AHIP Complete" value={`${data.compliance.ahipRate}%`} subtitle={`${data.compliance.ahipPassed} of ${data.compliance.ahipTotal} active + onboarding agents`} icon={<CheckCircle2 className="h-5 w-5 text-navy-700 dark:text-accent" />} />
        </div>
      </div>

      {/* Section: Sales & Pipeline */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sales & Pipeline</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="New clients & leads added"
            value={data.leads.total.toLocaleString()}
            subtitle={leadsTrend != null ? `${leadsTrend >= 0 ? "+" : ""}${leadsTrend}% vs prior period` : undefined}
            icon={<TrendingUp className={`h-5 w-5 ${leadsTrend != null && leadsTrend >= 0 ? "text-success" : "text-destructive"}`} />}
          />
          <StatCard title="Deals Won" value={data.deals.won} subtitle={`Win rate: ${data.deals.winRate}%`} icon={<CheckCircle2 className="h-5 w-5 text-success" />} />
          <StatCard title="Won Value" value={`$${data.deals.wonValue.toLocaleString()}`} icon={<DollarSign className="h-5 w-5 text-success" />} />
          <StatCard title="Active Pipeline" value={`$${data.deals.activePipelineValue.toLocaleString()}`} icon={<BarChart2 className="h-5 w-5 text-accent" />} />
        </div>
      </div>

      {/* Section: Win rate + comms summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Deal Outcomes</CardTitle><CardDescription>Period: {range.start} – {range.end}</CardDescription></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={[
                    { name: "Won", value: data.deals.won },
                    { name: "Lost", value: data.deals.lost },
                  ]}
                  cx="50%" cy="50%" innerRadius={55} outerRadius={80} dataKey="value"
                >
                  <Cell fill="#22a05a" />
                  <Cell fill="#dc2626" />
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
            <p className="text-center text-2xl font-bold mt-1">{data.deals.winRate}% <span className="text-sm font-normal text-muted-foreground">win rate</span></p>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardHeader><CardTitle className="font-display text-lg">Communications Volume</CardTitle><CardDescription>Outbound messages sent this period</CardDescription></CardHeader>
          <CardContent className="flex flex-col items-center justify-center h-40">
            <MessageSquare className="h-10 w-10 text-blue-400 mb-2" />
            <p className="text-4xl font-bold">{data.communications.outbound.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground mt-1">outbound messages</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function dateOffset(days: number) { return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }

async function downloadCsv(url: string, filename: string) {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  const res = await fetch(`${base}${url}`, {
    credentials: "include",
    headers: { "X-Confirm-Export": "true" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    if (body.code === "STEP_UP_REQUIRED") {
      // Signal the UI; Clerk session refresh happens on next request
      alert("Your session needs to be refreshed. Please reload the page and try again.");
    } else {
      alert(body.error ?? `Export failed (${res.status})`);
    }
    return;
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function StatCard({ title, value, icon, subtitle }: { title: string; value: string | number; icon?: React.ReactNode; subtitle?: string }) {
  return (
    <div className="h-full rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">{icon}</div>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{title}</p>
          <p className="font-display text-xl font-bold leading-tight">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <SectionCard>
      <SharedEmptyState
        icon={BarChart2}
        title={message}
        description="Numbers appear here as soon as there's activity in Mediflow for this period. Try a longer date range."
      />
    </SectionCard>
  );
}

// Types
type AgentPerfRow = { agentId: string; agentName: string; email: string; status: string; contactsWorked: number; callsLogged: number; dealsWon: number; dealValueWon: number; enrolledContacts: number; complianceScore: number; licensesActive: number; licensesExpiring: number; certificationsPassed: number; ahipStatus: string; smsSent?: number; emailSent?: number };
type PipelineReportRow = { pipelineId: string; pipelineName: string; totalDeals: number; wonDeals: number; lostDeals: number; winRate: number; totalWonValue: number; funnel: { stageId: string; stageName: string; orderIndex: number; dealCount: number; totalValue: number; wonCount: number; lostCount: number; avgTimeInStageHours?: number; conversionRate?: number }[] };
type LeadsReport = { sourceBreakdown: { source: string; total: number; converted: number; enrolled: number; conversionRate: number; enrollmentRate: number }[]; trend: { date: string; count: number }[]; totalLeads: number; convertedLeads: number };
type ComplianceMatrixReport = { licenseMatrix: AgentLicenseRow[]; expiryByMonth: { month: string; count: number }[]; carrierCertCompletion: { carrierId: string; carrierName: string; byYear: { year: number; total: number; passed: number; completionRate: number }[] }[]; ahipTrend: { year: number; total: number; passed: number; completionRate: number }[] };
type AgentLicenseRow = { agentId: string; agentName: string; licenses: { stateCode: string; licenseType: string; status: string; expiryDate: string | null; expiringIn90Days: boolean }[] };
type CommunicationsReport = {
  totalSms: number;
  totalEmail: number;
  aiAssistedSms: number;
  aiAssistedEmail: number;
  trend: { date: string; sms: number; email: number }[];
  optOutSmsContacts?: number;
  optOutEmailContacts?: number;
  byAgent?: { agentId: string; agentName: string; smsSent: number; emailSent: number }[];
};
type RetentionReport = {
  enrolledContacts: number;
  lostContacts: number;
  atRiskContacts: number;
  retentionRate: number;
  atRiskRate: number;
  monthlyTrend?: { month: string; enrolled: number; lost: number }[];
  aepWindow?: { isActive: boolean; start: string; end: string };
  oepWindow?: { isActive: boolean; start: string; end: string };
  upcomingBirthdays?: number;
  reEnrollmentOpportunity?: number;
};

type ExecutiveReport = {
  periodStart: string;
  periodEnd: string;
  agents: { active: number; onboarding: number };
  leads: { total: number; priorPeriod: number; changePercent: number | null };
  deals: { won: number; lost: number; winRate: number; wonValue: number; activePipelineValue: number };
  members: { enrolled: number };
  communications: { outbound: number };
  compliance: { ahipRate: number; ahipPassed: number; ahipTotal: number };
};

// ─── Main Reports Page ────────────────────────────────────────────────────────
export default function ReportsPage() {
  const { data: me } = useGetMe();
  const allowedRoles = ["super_admin", "agency_admin", "compliance_manager", "agent_support"];
  if (me && !allowedRoles.includes(me.role)) {
    return (
      <PageShell>
        <SectionCard>
          <SharedEmptyState icon={Lock} title="You don't have access to reports." description="Reports are available to admins, compliance managers and agent support." />
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Reporting & Analytics"
        subtitle="How the agency is doing — sales, agents, compliance, outreach and retention — with a spreadsheet for each"
      />

      <Tabs defaultValue="library">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="library">Report library</TabsTrigger>
          <TabsTrigger value="executive">Executive</TabsTrigger>
          <TabsTrigger value="agent-performance">Agent Performance</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="leads">Lead Sources</TabsTrigger>
          <TabsTrigger value="compliance-matrix">Compliance Matrix</TabsTrigger>
          <TabsTrigger value="communications">Communications</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="library"><ReportLibrary /></TabsContent>
          <TabsContent value="executive"><ExecutiveTab /></TabsContent>
          <TabsContent value="agent-performance"><AgentPerformanceTab /></TabsContent>
          <TabsContent value="pipeline"><PipelineTab /></TabsContent>
          <TabsContent value="leads"><LeadsTab /></TabsContent>
          <TabsContent value="compliance-matrix"><ComplianceMatrixTab /></TabsContent>
          <TabsContent value="communications"><CommunicationsTab /></TabsContent>
          <TabsContent value="retention"><RetentionTab /></TabsContent>
        </div>
      </Tabs>
    </PageShell>
  );
}
