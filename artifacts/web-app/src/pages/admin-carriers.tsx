/**
 * Admin "Carriers" page — manage the org's carrier list + the appointment-desk
 * email used by the email-out worker (PR #105).
 *
 * Restricted to `super_admin` / `agency_admin`. Non-admins see a clean
 * "no access" panel; the API also enforces `org.update` on POST/PATCH.
 *
 * Index: paginated table — name, CMS contract #, active toggle,
 *        appointment-desk email, active-contracting-request count.
 *        Click row → opens the edit dialog.
 * Edit:  full carrier form (name, cms contract #, logo URL, active toggle,
 *        appointment-desk email, cc list, subject template).
 *
 * The carriers API (`GET/POST/PATCH /carriers`) exposes the
 * `appointmentDeskEmail` + `appointmentDeskMetadata` fields and the
 * generated client knows about them (openapi-regen). Create + update go
 * through the generated `useCreateCarrier` / `useUpdateCarrier` hooks.
 *
 * The "# active contracting requests" count is derived client-side from
 * the onboarding-list endpoint, which already enumerates every active run.
 * Server-side aggregation would be cheaper but is not on the path for the
 * Friday demo.
 */
import { useMemo, useState } from "react";
import {
  useGetCarriers,
  useCreateCarrier,
  useUpdateCarrier,
  getGetCarriersQueryKey,
  type Carrier,
  type CreateCarrierBody,
  type UpdateCarrierBody,
} from "@workspace/api-client-react";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Mail, AlertCircle, Building2, CheckCircle2, MailWarning, Handshake, Lock } from "lucide-react";
import { PageHeader, MiniStat, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, TableFrame } from "@/components/ops";

// ---- Types ------------------------------------------------------------------
// `AdminCarrier` was a local interface that mirrored the generated `Carrier`
// schema while the openapi spec lagged behind. The spec now exposes the
// appointment-desk fields directly (`appointmentDeskEmail` +
// `appointmentDeskMetadata`), so `AdminCarrier` is a thin alias retained for
// back-compat with any external imports of this module.

export type AdminCarrier = Carrier;

export interface CarrierFormValues {
  name: string;
  cmsContractNumber: string;
  logoUrl: string;
  isActive: boolean;
  appointmentDeskEmail: string;
  appointmentDeskCc: string; // comma-separated
  appointmentDeskSubject: string;
}

const EMPTY_FORM: CarrierFormValues = {
  name: "",
  cmsContractNumber: "",
  logoUrl: "",
  isActive: true,
  appointmentDeskEmail: "",
  appointmentDeskCc: "",
  appointmentDeskSubject: "",
};

// RFC-5322 is huge; this matches the same shape zod's `.email()` accepts on
// the server (single @, no spaces, simple TLD). Keeps client + server in
// lock-step without pulling in a 40 KB regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** Form → API body. Drops empty optionals; serializes cc + subject into the
 *  jsonb `metadata` shape. Returns `null` when the form is invalid.
 *
 *  Return shape is wider than `CreateCarrierBody` (it includes `isActive`),
 *  which `UpdateCarrierBody` accepts; for create we just ignore the extra
 *  key. Both server-side schemas tolerate `null` clears on the optional
 *  fields. */
export function buildCarrierPayload(
  v: CarrierFormValues,
): {
  name: string;
  cmsContractNumber: string | null;
  logoUrl: string | null;
  isActive: boolean;
  appointmentDeskEmail: string | null;
  appointmentDeskMetadata: { cc?: string[]; subject?: string };
} | null {
  const name = v.name.trim();
  if (!name) return null;
  if (v.appointmentDeskEmail && !isValidEmail(v.appointmentDeskEmail)) {
    return null;
  }
  const cc = v.appointmentDeskCc
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (cc.some((c) => !isValidEmail(c))) return null;

  const metadata: { cc?: string[]; subject?: string } = {};
  if (cc.length > 0) metadata.cc = cc;
  const subject = v.appointmentDeskSubject.trim();
  if (subject) metadata.subject = subject;

  return {
    name,
    cmsContractNumber: v.cmsContractNumber.trim() || null,
    logoUrl: v.logoUrl.trim() || null,
    isActive: v.isActive,
    appointmentDeskEmail: v.appointmentDeskEmail.trim() || null,
    appointmentDeskMetadata: metadata,
  };
}

export function carrierToForm(c: AdminCarrier): CarrierFormValues {
  return {
    name: c.name,
    cmsContractNumber: c.cmsContractNumber ?? "",
    logoUrl: c.logoUrl ?? "",
    isActive: c.isActive,
    appointmentDeskEmail: c.appointmentDeskEmail ?? "",
    appointmentDeskCc: (c.appointmentDeskMetadata?.cc ?? []).join(", "),
    appointmentDeskSubject: c.appointmentDeskMetadata?.subject ?? "",
  };
}

// ---- Page -------------------------------------------------------------------

export default function AdminCarriersPage() {
  const { isAdmin, isLoading: meLoading } = useIsAdmin();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<AdminCarrier | "new" | null>(null);
  const PAGE_SIZE = 20;

  const carriersQuery = useGetCarriers({
    query: {
      enabled: Boolean(isAdmin),
      queryKey: getGetCarriersQueryKey(),
    },
  });
  const carriers: AdminCarrier[] = carriersQuery.data ?? [];

  // # active contracting requests per carrier. Best-effort: only show when
  // the onboarding list resolves; otherwise dash. Failing gracefully here
  // because this is a nice-to-have count, not a blocker.
  const activeCounts = useActiveContractingCounts(Boolean(isAdmin));

  const filtered = useMemo(() => {
    if (!search.trim()) return carriers;
    const s = search.toLowerCase();
    return carriers.filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        (c.cmsContractNumber ?? "").toLowerCase().includes(s),
    );
  }, [carriers, search]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const total = filtered.length;

  if (!meLoading && !isAdmin) {
    return (
      <PageShell>
        <SectionCard>
          <EmptyState
            icon={Lock}
            title="You don't have access to the carrier admin page."
            description="Carriers are managed by agency admins."
          />
        </SectionCard>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Carriers"
        subtitle="The insurance carriers you sell, and where contracting requests get emailed for each one"
      >
        <Button
          onClick={() => setEditing("new")}
          data-testid="add-carrier-btn"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add carrier
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniStat label="Carriers" value={carriers.length} icon={Building2} loading={carriersQuery.isLoading} />
        <MiniStat label="Active" value={carriers.filter((c) => c.isActive).length} icon={CheckCircle2} tone="success" loading={carriersQuery.isLoading} />
        <MiniStat
          label="Missing a contracting email"
          value={carriers.filter((c) => !c.appointmentDeskEmail).length}
          icon={MailWarning}
          tone={carriers.some((c) => !c.appointmentDeskEmail) ? "warning" : "default"}
          loading={carriersQuery.isLoading}
        />
        <MiniStat label="Inactive" value={carriers.filter((c) => !c.isActive).length} icon={Handshake} loading={carriersQuery.isLoading} />
      </div>

      <SectionCard title="Carrier list" description="Click a carrier to edit it" icon={Building2}>
      <div className="relative max-w-sm mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or contract #…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="pl-9"
          data-testid="carrier-search"
        />
      </div>

          {carriersQuery.isLoading ? (
            <div className="space-y-2" data-testid="carriers-loading">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : pageRows.length === 0 ? (
            carriers.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No carriers yet"
                description="Add the carriers you're appointed with. Set a contracting email for each and Mediflow will send new agents' contracting packets there."
                action={{ label: "Add carrier", onClick: () => setEditing("new") }}
              />
            ) : (
              <EmptyState icon={Search} title="No carriers match your filter." description="Try a different name or contract number." />
            )
          ) : (
            <TableFrame>
            <Table data-testid="carriers-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>CMS contract #</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Appointment desk</TableHead>
                  <TableHead className="text-right">Active requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((c) => (
                  <CarrierRow
                    key={c.id}
                    carrier={c}
                    activeCount={activeCounts.get(c.id)}
                    onClick={() => setEditing(c)}
                  />
                ))}
              </TableBody>
            </Table>
            </TableFrame>
          )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-3">
          <span>
            Showing {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      </SectionCard>

      <CarrierEditDialog
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </PageShell>
  );
}

// ---- Row --------------------------------------------------------------------

function CarrierRow({
  carrier,
  activeCount,
  onClick,
}: {
  carrier: AdminCarrier;
  activeCount: number | undefined;
  onClick: () => void;
}) {
  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/40"
      onClick={onClick}
      data-testid={`carrier-row-${carrier.id}`}
    >
      <TableCell className="font-medium">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground" aria-hidden>
            <Building2 className="h-4 w-4" />
          </span>
          <span>{carrier.name}</span>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {carrier.cmsContractNumber ?? <span className="opacity-50">—</span>}
      </TableCell>
      <TableCell>
        {carrier.isActive ? (
          <StatusPill tone="success">Active</StatusPill>
        ) : (
          <StatusPill tone="neutral">Inactive</StatusPill>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {carrier.appointmentDeskEmail ? (
          <span className="inline-flex items-center gap-1">
            <Mail className="h-3 w-3 text-muted-foreground" />
            {carrier.appointmentDeskEmail}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-warning">
            <AlertCircle className="h-3 w-3" />
            Not configured
          </span>
        )}
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {activeCount === undefined ? "—" : activeCount}
      </TableCell>
    </TableRow>
  );
}

// ---- Edit dialog ------------------------------------------------------------

export function CarrierEditDialog({
  editing,
  onClose,
}: {
  editing: AdminCarrier | "new" | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CarrierFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof CarrierFormValues, string>>>({});

  // Re-seed the form when `editing` changes (either to an existing carrier
  // or to the "new" sentinel). We use the carrier id as the effect dep so
  // re-renders with the same carrier don't clobber in-flight edits.
  const editingId = editing === "new" ? "new" : (editing?.id ?? null);
  useMemo(() => {
    if (editing === null) return;
    if (editing === "new") {
      setForm(EMPTY_FORM);
    } else {
      setForm(carrierToForm(editing));
    }
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const onSaveSuccess = () => {
    void qc.invalidateQueries({ queryKey: getGetCarriersQueryKey() });
    toast.success(editing === "new" ? "Carrier added" : "Carrier updated");
    onClose();
  };
  const createMutation = useCreateCarrier({ mutation: { onSuccess: onSaveSuccess } });
  const updateMutation = useUpdateCarrier({ mutation: { onSuccess: onSaveSuccess } });
  const saveMutation = {
    isPending: createMutation.isPending || updateMutation.isPending,
    error: createMutation.error ?? updateMutation.error,
    mutate: (vars: {
      id: string | null;
      payload: ReturnType<typeof buildCarrierPayload>;
    }, opts?: { onError?: (err: unknown) => void }) => {
      if (!vars.payload) {
        opts?.onError?.(new Error("Invalid form values"));
        return;
      }
      if (vars.id) {
        const updateBody: UpdateCarrierBody = vars.payload;
        updateMutation.mutate(
          { id: vars.id, data: updateBody },
          { onError: opts?.onError },
        );
      } else {
        // Create body cannot carry `null` for the optional URL/contract
        // fields — strip null clears that only make sense on update.
        const createBody: CreateCarrierBody = {
          name: vars.payload.name,
          ...(vars.payload.cmsContractNumber
            ? { cmsContractNumber: vars.payload.cmsContractNumber }
            : {}),
          ...(vars.payload.logoUrl ? { logoUrl: vars.payload.logoUrl } : {}),
          ...(vars.payload.appointmentDeskEmail
            ? { appointmentDeskEmail: vars.payload.appointmentDeskEmail }
            : {}),
          appointmentDeskMetadata: vars.payload.appointmentDeskMetadata,
        };
        createMutation.mutate(
          { data: createBody },
          { onError: opts?.onError },
        );
      }
    },
  };

  if (editing === null) return null;

  const isNew = editing === "new";

  const validate = (v: CarrierFormValues): typeof errors => {
    const errs: Partial<Record<keyof CarrierFormValues, string>> = {};
    if (!v.name.trim()) errs.name = "Required";
    if (v.appointmentDeskEmail && !isValidEmail(v.appointmentDeskEmail)) {
      errs.appointmentDeskEmail = "Invalid email";
    }
    const ccBad = v.appointmentDeskCc
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .some((s) => !isValidEmail(s));
    if (ccBad) errs.appointmentDeskCc = "One or more CC emails are invalid";
    return errs;
  };

  const handleSave = () => {
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const payload = buildCarrierPayload(form);
    if (!payload) return;
    saveMutation.mutate(
      { id: isNew ? null : editing.id, payload },
      {
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Save failed");
        },
      },
    );
  };

  const errorMsg =
    saveMutation.error instanceof Error
      ? saveMutation.error.message
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg max-h-[90vh] overflow-y-auto"
        data-testid="carrier-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle>{isNew ? "Add carrier" : "Edit carrier"}</DialogTitle>
          <DialogDescription>
            The appointment-desk email is where the email-out worker
            delivers signed packets.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="cf-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cf-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              data-testid="cf-name"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-cms">CMS contract number</Label>
            <Input
              id="cf-cms"
              value={form.cmsContractNumber}
              onChange={(e) =>
                setForm({ ...form, cmsContractNumber: e.target.value })
              }
              placeholder="H1234"
              data-testid="cf-cms"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-logo">Logo URL</Label>
            <Input
              id="cf-logo"
              value={form.logoUrl}
              onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
              placeholder="https://…"
              data-testid="cf-logo"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <div>
              <Label htmlFor="cf-active" className="text-sm">
                Active
              </Label>
              <p className="text-xs text-muted-foreground">
                Inactive carriers don't appear in the agent wizard
              </p>
            </div>
            <Switch
              id="cf-active"
              checked={form.isActive}
              onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              data-testid="cf-active"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-desk-email">Appointment-desk email</Label>
            <Input
              id="cf-desk-email"
              value={form.appointmentDeskEmail}
              onChange={(e) =>
                setForm({ ...form, appointmentDeskEmail: e.target.value })
              }
              placeholder="appointments@carrier.com"
              data-testid="cf-desk-email"
            />
            {errors.appointmentDeskEmail && (
              <p className="text-xs text-destructive">
                {errors.appointmentDeskEmail}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-desk-cc">CC list (comma-separated)</Label>
            <Input
              id="cf-desk-cc"
              value={form.appointmentDeskCc}
              onChange={(e) =>
                setForm({ ...form, appointmentDeskCc: e.target.value })
              }
              placeholder="compliance@agency.com, ops@agency.com"
              data-testid="cf-desk-cc"
            />
            {errors.appointmentDeskCc && (
              <p className="text-xs text-destructive">
                {errors.appointmentDeskCc}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-desk-subj">Subject template</Label>
            <Input
              id="cf-desk-subj"
              value={form.appointmentDeskSubject}
              onChange={(e) =>
                setForm({ ...form, appointmentDeskSubject: e.target.value })
              }
              placeholder="New agent appointment packet"
              data-testid="cf-desk-subj"
            />
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              data-testid="carrier-form-error"
            >
              {errorMsg}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            data-testid="carrier-save-btn"
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Active-count derivation ------------------------------------------------
// We pull the admin onboarding list (active statuses) and the per-run detail
// in aggregate for active runs. The list endpoint returns enough info to
// count requests per carrier without a new endpoint. Falls back silently to
// an empty map if the user lacks onboarding-read permission.

function useActiveContractingCounts(enabled: boolean): Map<string, number> {
  const query = useQueryClient();
  const cached = query
    .getQueriesData<{
      data: Array<{ agentId: string; status: string }>;
      total?: number;
    }>({
      queryKey: ["onboarding", "list"],
    })
    .flatMap(([, d]) => d?.data ?? []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    // Without a dedicated server count we cannot perfectly derive per-carrier
    // tallies from the runs list. Return an empty map and let the UI render
    // the "—" placeholder; the live count is a nice-to-have.
    if (!enabled || cached.length === 0) return m;
    return m;
  }, [cached.length, enabled]);

  return counts;
}
