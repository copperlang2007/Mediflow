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
  CheckCircle2, XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

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
      <SelectTrigger className="w-40">
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
        <StatCard title="Total Agents" value={data.length} icon={<Users className="h-5 w-5 text-blue-500" />} />
        <StatCard title="Total Deals Won" value={data.reduce((s, r) => s + r.dealsWon, 0)} icon={<TrendingUp className="h-5 w-5 text-green-500" />} />
        <StatCard title="Avg Compliance Score" value={`${Math.round(data.reduce((s, r) => s + r.complianceScore, 0) / data.length)}%`} icon={<ShieldCheck className="h-5 w-5 text-purple-500" />} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deals Won by Agent</CardTitle>
          <CardDescription>Top performing agents in the selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sorted.slice(0, 15)}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="agentName" tick={{ fontSize: 11 }} tickFormatter={(v) => v.split(" ")[0]} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="dealsWon" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Deals Won" />
              <Bar dataKey="enrolledContacts" fill="#10b981" radius={[4, 4, 0, 0]} name="Enrolled" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Compliance Score by Agent</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {sorted.slice(0, 20).map((agent) => (
              <div key={agent.agentId} className="flex items-center gap-3">
                <span className="text-sm w-36 truncate text-muted-foreground">{agent.agentName}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${agent.complianceScore >= 75 ? "bg-green-500" : agent.complianceScore >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                    style={{ width: `${agent.complianceScore}%` }}
                  />
                </div>
                <span className="text-sm font-medium w-10 text-right">{agent.complianceScore}%</span>
                <Badge variant={agent.ahipStatus === "passed" ? "default" : "secondary"} className="text-xs w-20 justify-center">
                  {agent.ahipStatus === "passed" ? "AHIP ✓" : "No AHIP"}
                </Badge>
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
      <DateRangePicker value={range} onChange={setRange} />

      {data.map((pipeline) => (
        <Card key={pipeline.pipelineId}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{pipeline.pipelineName}</CardTitle>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Win Rate: <span className="font-semibold text-foreground">{pipeline.winRate}%</span></span>
                <span>Won Value: <span className="font-semibold text-green-600">${pipeline.totalWonValue.toLocaleString()}</span></span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-3 bg-muted/50 rounded-lg"><p className="text-2xl font-bold">{pipeline.totalDeals}</p><p className="text-xs text-muted-foreground">Total Deals</p></div>
              <div className="p-3 bg-green-50 rounded-lg"><p className="text-2xl font-bold text-green-600">{pipeline.wonDeals}</p><p className="text-xs text-muted-foreground">Won</p></div>
              <div className="p-3 bg-red-50 rounded-lg"><p className="text-2xl font-bold text-red-500">{pipeline.lostDeals}</p><p className="text-xs text-muted-foreground">Lost</p></div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={pipeline.funnel}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="stageName" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="dealCount" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Active" />
                <Bar dataKey="wonCount" fill="#10b981" radius={[4, 4, 0, 0]} name="Won" />
                <Bar dataKey="lostCount" fill="#ef4444" radius={[4, 4, 0, 0]} name="Lost" />
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
      <DateRangePicker value={range} onChange={setRange} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard title="Total Leads" value={data.totalLeads} icon={<Users className="h-5 w-5 text-blue-500" />} />
        <StatCard title="Converted Leads" value={data.convertedLeads} subtitle={data.totalLeads > 0 ? `${Math.round((data.convertedLeads / data.totalLeads) * 100)}% conversion` : undefined} icon={<TrendingUp className="h-5 w-5 text-green-500" />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Leads by Source</CardTitle></CardHeader>
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

        <Card>
          <CardHeader><CardTitle>Weekly Lead Volume</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} name="Leads" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Source Breakdown Detail</CardTitle></CardHeader>
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
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>AHIP Certification Trend</CardTitle>
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
                <Bar dataKey="passed" fill="#10b981" radius={[4, 4, 0, 0]} name="Passed" />
                <Bar dataKey="total" fill="#e2e8f0" radius={[4, 4, 0, 0]} name="Total" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>License Expiry Heatmap</CardTitle>
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

      <Card>
        <CardHeader>
          <CardTitle>Carrier Cert Completion by Carrier</CardTitle>
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
                    <div className="h-2 rounded-full bg-blue-500" style={{ width: `${currentYear.completionRate}%` }} />
                  </div>
                  <span className="text-sm font-medium w-12 text-right">{currentYear.completionRate}%</span>
                  <span className="text-xs text-muted-foreground w-20 text-right">{currentYear.passed}/{currentYear.total}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Agent License Matrix</CardTitle></CardHeader>
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
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Download className="h-4 w-4 mr-1.5" /> Print
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="SMS Sent" value={data.totalSms.toLocaleString()} icon={<MessageSquare className="h-5 w-5 text-blue-500" />} />
        <StatCard title="Emails Sent" value={data.totalEmail.toLocaleString()} icon={<MessageSquare className="h-5 w-5 text-purple-500" />} />
        <StatCard title="AI-Assisted SMS" value={data.aiAssistedSms.toLocaleString()} subtitle={data.totalSms > 0 ? `${Math.round((data.aiAssistedSms / data.totalSms) * 100)}% AI-written` : undefined} icon={<TrendingUp className="h-5 w-5 text-green-500" />} />
        <StatCard title="AI-Assisted Email" value={data.aiAssistedEmail.toLocaleString()} subtitle={data.totalEmail > 0 ? `${Math.round((data.aiAssistedEmail / data.totalEmail) * 100)}% AI-written` : undefined} icon={<TrendingUp className="h-5 w-5 text-orange-500" />} />
      </div>

      {/* Delivery & opt-out metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          title="SMS Opt-outs"
          value={(data.optOutSmsContacts ?? 0).toLocaleString()}
          subtitle="Contacts opted out of SMS"
          icon={<XCircle className="h-5 w-5 text-red-500" />}
        />
        <StatCard
          title="Email Opt-outs"
          value={(data.optOutEmailContacts ?? 0).toLocaleString()}
          subtitle="Contacts opted out of email"
          icon={<XCircle className="h-5 w-5 text-red-400" />}
        />
        <StatCard
          title="Effective Delivery Rate"
          value={`${deliveryRate}%`}
          subtitle="SMS recipients not opted out"
          icon={<CheckCircle2 className="h-5 w-5 text-green-500" />}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Weekly Volume Trend</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.trend}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="sms" stroke="#3b82f6" strokeWidth={2} dot={false} name="SMS" />
              <Line type="monotone" dataKey="email" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Email" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Per-agent leaderboard */}
      {data.byAgent && data.byAgent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Agent Outreach Leaderboard</CardTitle>
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
      <div className="flex justify-end print:hidden">
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Download className="h-4 w-4 mr-1.5" /> Print
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Enrolled Members" value={data.enrolledContacts.toLocaleString()} icon={<CheckCircle2 className="h-5 w-5 text-green-500" />} />
        <StatCard title="At-Risk Members" value={data.atRiskContacts.toLocaleString()} subtitle="No activity 60+ days" icon={<AlertTriangle className="h-5 w-5 text-yellow-500" />} />
        <StatCard title="Lost Members" value={data.lostContacts.toLocaleString()} icon={<XCircle className="h-5 w-5 text-red-500" />} />
        <StatCard
          title="Re-enrollment Opportunities"
          value={(data.reEnrollmentOpportunity ?? 0).toLocaleString()}
          subtitle="AEP-eligible lost members"
          icon={<TrendingUp className="h-5 w-5 text-blue-500" />}
        />
      </div>

      {/* AEP / OEP window banners */}
      {data.aepWindow?.isActive && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-blue-800">Annual Enrollment Period (AEP) is active</p>
            <p className="text-sm text-blue-700 mt-0.5">
              {data.reEnrollmentOpportunity ?? 0} lost members are re-enrollment candidates. Consider outreach sequences now.
            </p>
          </div>
        </div>
      )}

      {data.upcomingBirthdays != null && data.upcomingBirthdays > 0 && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-4 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-purple-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-purple-800">{data.upcomingBirthdays} member(s) turning 65 in the next 90 days</p>
            <p className="text-sm text-purple-700 mt-0.5">These contacts qualify for Medicare Part B enrollment — consider a targeted outreach campaign.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Retention Rate</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center justify-center h-48">
            <div className="text-6xl font-bold text-green-600">{data.retentionRate}%</div>
            <p className="text-muted-foreground mt-2">Overall member retention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Member Status Breakdown</CardTitle></CardHeader>
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
                  <Cell fill="#10b981" />
                  <Cell fill="#f59e0b" />
                  <Cell fill="#ef4444" />
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
        <Card>
          <CardHeader>
            <CardTitle>Monthly Enrollment Trend</CardTitle>
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
                <Bar dataKey="enrolled" fill="#10b981" radius={[4, 4, 0, 0]} name="Enrolled" />
                <Bar dataKey="lost" fill="#ef4444" radius={[4, 4, 0, 0]} name="Lost" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {data.atRiskRate > 10 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-yellow-800">{data.atRiskRate}% of enrolled members are at risk</p>
            <p className="text-sm text-yellow-700 mt-0.5">Consider running a re-engagement sequence for members with no activity in the past 60 days.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function dateOffset(days: number) { return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }

async function downloadCsv(url: string, filename: string) {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  const res = await fetch(`${base}${url}`, { credentials: "include" });
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function StatCard({ title, value, icon, subtitle }: { title: string; value: string | number; icon?: React.ReactNode; subtitle?: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        {icon && <div className="mt-0.5">{icon}</div>}
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
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
    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
      <BarChart2 className="h-12 w-12 mb-3 opacity-30" />
      <p>{message}</p>
    </div>
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

// ─── Main Reports Page ────────────────────────────────────────────────────────
export default function ReportsPage() {
  const { data: me } = useGetMe();
  const allowedRoles = ["super_admin", "agency_admin", "compliance_manager", "agent_support"];
  if (me && !allowedRoles.includes(me.role)) {
    return <div className="p-8 text-center text-muted-foreground">You don't have access to reports.</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart2 className="h-6 w-6 text-blue-600" />
          Analytics & Reports
        </h1>
        <p className="text-muted-foreground mt-1">Agency performance, compliance, and pipeline analytics.</p>
      </div>

      <Tabs defaultValue="agent-performance">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="agent-performance">Agent Performance</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="leads">Lead Sources</TabsTrigger>
          <TabsTrigger value="compliance-matrix">Compliance Matrix</TabsTrigger>
          <TabsTrigger value="communications">Communications</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="agent-performance"><AgentPerformanceTab /></TabsContent>
          <TabsContent value="pipeline"><PipelineTab /></TabsContent>
          <TabsContent value="leads"><LeadsTab /></TabsContent>
          <TabsContent value="compliance-matrix"><ComplianceMatrixTab /></TabsContent>
          <TabsContent value="communications"><CommunicationsTab /></TabsContent>
          <TabsContent value="retention"><RetentionTab /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
