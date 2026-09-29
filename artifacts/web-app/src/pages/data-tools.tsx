/**
 * Data Import / Export (agencyBRIDGE DataToolsPage).
 *
 *   Export: whole-book CSVs from `/api/reports/{contacts,policies,agents}/export`
 *           — same step-up confirm and audit log as the
 *           existing exports.
 *   Import: the existing, validated import wizards on /data-migration
 *           (generic CSV for clients + their plans, Monday.com for agents),
 *           plus blank templates and the real import history.
 */
import { useState, type ComponentType } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  Download,
  FileDown,
  FileSpreadsheet,
  FileText,
  History,
  Info,
  ShieldCheck,
  Upload,
  UserCog,
  Users,
} from "lucide-react";
import {
  customFetch,
  useGetAgents,
  useGetContacts,
  useGetMe,
  type ImportJob,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { downloadCsvText, downloadExport } from "@/lib/exports";
import { GhlConnectionCard } from "@/components/integrations/GhlConnectionCard";

type Kind = "clients" | "policies" | "agents";

/** Columns in each export — must match api-server routes/dataExports.ts. */
export const EXPORT_COLUMNS: Record<Kind, string[]> = {
  clients: ["id", "firstName", "lastName", "email", "phone", "status", "currentPlanType", "stateCode", "zipCode", "leadSource", "createdAt"],
  policies: ["policyId", "contactId", "clientName", "carrier", "planType", "planName", "planId", "planYear", "policyNumber", "applicationDate", "effectiveDate", "effectuated", "status", "disenrolledDate", "writingAgent"],
  agents: ["id", "firstName", "lastName", "email", "phone", "npn", "status", "hireDate", "createdAt"],
};

/**
 * Blank import templates. Headers match what the import wizards recognise
 * automatically (api-server lib/contactImport.ts and the Monday.com mapper).
 */
export const IMPORT_TEMPLATES: Record<Kind, string[]> = {
  clients: ["First Name", "Last Name", "Email", "Phone", "Date of Birth", "Street Address", "City", "County", "State", "ZIP Code", "Medicare ID", "Assigned Agent Email", "Lead Source", "Tags"],
  policies: ["First Name", "Last Name", "Email", "Phone", "Date of Birth", "Medicare ID", "Carrier", "Plan Name", "Plan Type", "Effective Date", "Assigned Agent Email"],
  agents: ["First Name", "Last Name", "Email", "Phone", "NPN", "Licensed States", "Status", "Hire Date"],
};

const EXPORT_URL: Record<Kind, string> = {
  clients: "/api/reports/contacts/export",
  policies: "/api/reports/policies/export",
  agents: "/api/reports/agents/export",
};

/** Mirrors the server gates (contact:update / agent:update). */
const EXPORT_ROLES: Record<Kind, string[]> = {
  clients: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
  policies: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
  agents: ["super_admin", "agency_admin", "compliance_manager"],
};
const IMPORT_ROLES = ["super_admin", "agency_admin"];

type Summary = { total: number };

export default function DataToolsPage() {
  const { data: me } = useGetMe();
  const role = me?.role ?? "";
  const [tab, setTab] = useState<Kind>("clients");

  const contacts = useGetContacts({ limit: 1 });
  const agents = useGetAgents({ limit: 1 });
  const policies = useQuery({
    queryKey: ["/api/enrollments/summary", "book"],
    queryFn: () => customFetch<Summary>("/api/enrollments/summary"),
  });
  const history = useQuery({
    queryKey: ["/api/imports/history"],
    queryFn: () => customFetch<ImportJob[]>("/api/imports/history"),
    enabled: IMPORT_ROLES.includes(role),
  });

  const counts: Record<Kind, number | undefined> = {
    clients: contacts.data?.total,
    policies: policies.data?.total,
    agents: agents.data?.total,
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Data Import / Export"
        subtitle="Download your clients, policies and agents as spreadsheets, or bring data in from another system. Every import is checked row by row before anything is saved."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Kind)}>
        <TabsList>
          <TabsTrigger value="clients" className="gap-1.5"><Users className="h-3.5 w-3.5" /> Clients{counts.clients != null ? ` (${counts.clients})` : ""}</TabsTrigger>
          <TabsTrigger value="policies" className="gap-1.5"><FileText className="h-3.5 w-3.5" /> Policies{counts.policies != null ? ` (${counts.policies})` : ""}</TabsTrigger>
          <TabsTrigger value="agents" className="gap-1.5"><UserCog className="h-3.5 w-3.5" /> Agents{counts.agents != null ? ` (${counts.agents})` : ""}</TabsTrigger>
        </TabsList>

        {(["clients", "policies", "agents"] as Kind[]).map((kind) => (
          <TabsContent key={kind} value={kind} className="mt-4 space-y-4">
            <ExportCard kind={kind} role={role} count={counts[kind]} />
            <ImportCard kind={kind} role={role} />
          </TabsContent>
        ))}
      </Tabs>

      {IMPORT_ROLES.includes(role) && <GhlConnectionCard />}

      {IMPORT_ROLES.includes(role) && (
        <SectionCard title="Recent imports" icon={History} description="The last imports anyone in your agency ran, newest first.">
          {history.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !history.data || history.data.length === 0 ? (
            <EmptyState compact icon={History} title="No imports yet" description="When you import a file, its results show here." />
          ) : (
            <ul className="divide-y divide-border">
              {history.data.slice(0, 10).map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-accent" />
                  <span className="font-medium truncate max-w-[220px]">{job.fileName ?? job.importType.replace(/_/g, " ")}</span>
                  <StatusPill status={job.status} />
                  <span className="text-xs text-muted-foreground">
                    {job.createdCount} added · {job.updatedCount} updated · {job.skippedCount} skipped
                    {job.errorCount > 0 ? ` · ${job.errorCount} with problems` : ""}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}

const LABEL: Record<Kind, { noun: string; plural: string; icon: ComponentType<{ className?: string }> }> = {
  clients: { noun: "client", plural: "clients", icon: Users },
  policies: { noun: "policy", plural: "policies", icon: FileText },
  agents: { noun: "agent", plural: "agents", icon: UserCog },
};

function ExportCard({ kind, role, count }: { kind: Kind; role: string; count: number | undefined }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const allowed = EXPORT_ROLES[kind].includes(role);
  const { plural } = LABEL[kind];

  const run = async () => {
    setBusy(true);
    const res = await downloadExport(EXPORT_URL[kind], `${plural}-${new Date().toISOString().slice(0, 10)}.csv`);
    setBusy(false);
    if (res.ok) toast({ title: "Export ready", description: `Your ${plural} file has downloaded.` });
    else toast({ title: "Couldn't export", description: res.message, variant: "destructive" });
  };

  return (
    <SectionCard
      title={`Export ${plural}`}
      icon={Download}
      description={`Download every ${LABEL[kind].noun} in your agency as a CSV file for backup, migration or your own analysis.`}
    >
      <div className="flex flex-wrap gap-2">
        {allowed ? (
          <Button onClick={() => void run()} disabled={busy}>
            <FileDown className="mr-1.5 h-4 w-4" />
            {busy ? "Preparing…" : count != null ? `Export ${count} ${count === 1 ? LABEL[kind].noun : plural}` : `Export ${plural}`}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Your role can't export {plural}. Ask an agency admin.</p>
        )}
        <Button variant="outline" onClick={() => downloadCsvText([IMPORT_TEMPLATES[kind]], `${kind}-import-template.csv`)}>
          <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Download CSV template
        </Button>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground mb-2">Exported columns ({EXPORT_COLUMNS[kind].length}):</p>
        <div className="flex flex-wrap gap-1.5">
          {EXPORT_COLUMNS[kind].map((c) => (
            <code key={c} className="rounded-md bg-card border border-border px-2 py-0.5 text-[11px] font-mono">{c}</code>
          ))}
        </div>
      </div>

      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-accent" />
        {kind === "clients"
          ? "Medicare IDs are never included in exports. Every export is recorded in the audit log."
          : kind === "policies"
            ? "No Medicare IDs are included. Every export is recorded in the audit log."
            : "Contracting details (SSN, EIN, date of birth) are never exported. Every export is recorded in the audit log."}
        {" "}You may be asked to sign in again first.
      </p>
    </SectionCard>
  );
}

function ImportCard({ kind, role }: { kind: Kind; role: string }) {
  const canImport = IMPORT_ROLES.includes(role);
  const { plural } = LABEL[kind];
  const how =
    kind === "agents"
      ? "Use the Monday.com importer: upload a board export (or any CSV with the template's columns), match the columns, preview, then import. Agents come in with their licensed states."
      : kind === "policies"
        ? "Policies come in with their clients: add Carrier, Plan Type and Effective Date columns to your client file and each row becomes a policy on that client's record."
        : "Use the CSV importer: upload your file, match its columns to ours, review duplicates and problems, then confirm. Nothing is saved until you confirm.";

  return (
    <SectionCard title={`Import ${plural}`} icon={Upload} description={how}>
      <div className="rounded-xl border-2 border-dashed border-border bg-muted/20 p-6 text-center">
        <Upload className="mx-auto h-8 w-8 text-accent" />
        <p className="mt-2 text-sm font-medium">
          {kind === "agents" ? "Import from Monday.com or CSV" : "Import from a CSV file"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Start from the template above for the smoothest match. Files up to 50 MB.</p>
        {canImport ? (
          <Button className="mt-4" asChild>
            <Link href="/data-migration">
              Open the import wizard <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">Only agency owners can import data.</p>
        )}
      </div>
      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        {kind === "agents"
          ? "In the wizard, choose the “Monday.com (Agents)” tab."
          : "In the wizard, choose the “Generic CSV (Contacts)” tab. Moving from GoHighLevel? Use its tab instead."}
      </p>
    </SectionCard>
  );
}
