/**
 * Calendar & Appointments (stage2/calendar-branding) — modelled on the
 * agencyBRIDGE CalendarPage. Month, week and agenda views over real
 * appointments from /api/appointments; every number on the page is a count of
 * what that call returned for the visible range.
 *
 * Google / Microsoft calendar sync is not built: the page says so plainly.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInMinutes,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  CalendarDays,
  CalendarSync,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Home,
  MapPin,
  Phone,
  Plus,
  Video,
} from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AppointmentDialog } from "@/components/calendar/AppointmentDialog";
import {
  LOCATION_LABELS,
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_CHIP,
  TYPE_DOT,
  TYPE_LABELS,
  APPOINTMENT_TYPES,
  appointmentsKey,
  listAgentOptions,
  listAppointments,
  personName,
  type Appointment,
  type LocationType,
} from "@/lib/appointments";
import { cn } from "@/lib/utils";

type View = "month" | "week" | "agenda";

const CREATE_ROLES = new Set(["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent"]);
const DELETE_ROLES = new Set(["super_admin", "agency_admin", "agent"]);

const LOCATION_ICON: Record<LocationType, typeof MapPin> = {
  office: MapPin,
  phone: Phone,
  video: Video,
  home: Home,
};

function rangeFor(view: View, anchor: Date): { from: Date; to: Date } {
  if (view === "month") {
    return {
      from: startOfWeek(startOfMonth(anchor)),
      to: addDays(endOfWeek(endOfMonth(anchor)), 1),
    };
  }
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfDay(anchor);
  return { from, to: addDays(from, 30) };
}

function rangeTitle(view: View, anchor: Date): string {
  if (view === "month") return format(anchor, "MMMM yyyy");
  if (view === "week") {
    const s = startOfWeek(anchor);
    const e = endOfWeek(anchor);
    return isSameMonth(s, e)
      ? `${format(s, "MMM d")} – ${format(e, "d, yyyy")}`
      : `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`;
  }
  return `Next 30 days from ${format(anchor, "MMM d")}`;
}

function StatTile({ label, value, className, loading }: { label: string; value: number; className: string; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-8 w-12" />
      ) : (
        <p className={cn("font-display text-2xl font-bold", className)}>{value}</p>
      )}
    </div>
  );
}

function AppointmentCard({ appt, onClick }: { appt: Appointment; onClick: () => void }) {
  const LocIcon = LOCATION_ICON[appt.locationType] ?? MapPin;
  const start = new Date(appt.startsAt);
  const mins = differenceInMinutes(new Date(appt.endsAt), start);
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", TYPE_CHIP[appt.type])}>
          {TYPE_LABELS[appt.type]}
        </span>
        <StatusPill tone={STATUS_TONE[appt.status]}>{STATUS_LABELS[appt.status]}</StatusPill>
      </div>
      <p className="text-sm font-medium">{personName(appt.contact) ?? appt.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {personName(appt.contact) ? appt.title : null}
        {personName(appt.contact) && personName(appt.agent) ? " · " : null}
        {personName(appt.agent) ?? (personName(appt.contact) ? null : "Unassigned")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" /> {format(start, "h:mm a")} · {mins} min
        </span>
        <span className="flex items-center gap-1">
          <LocIcon className="h-3.5 w-3.5" /> {LOCATION_LABELS[appt.locationType]}
        </span>
      </div>
      {appt.notes && <p className="mt-2 line-clamp-2 text-xs italic text-muted-foreground">{appt.notes}</p>}
    </button>
  );
}

export default function CalendarPage() {
  const { data: me } = useGetMe();
  const role = (me?.role as string | undefined) ?? null;
  const canCreate = role ? CREATE_ROLES.has(role) : false;
  const canDelete = role ? DELETE_ROLES.has(role) : false;
  const isAgent = role === "agent";

  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => new Date());
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [dialog, setDialog] = useState<{ open: boolean; appt: Appointment | null; date?: Date }>({
    open: false,
    appt: null,
  });

  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const agentId = agentFilter === "all" ? undefined : agentFilter;

  const { data, isLoading, isError } = useQuery({
    queryKey: appointmentsKey(fromIso, toIso, agentId),
    queryFn: () => listAppointments(fromIso, toIso, agentId),
  });
  const agents = useQuery({
    queryKey: ["/api/appointments/agent-options"],
    queryFn: listAgentOptions,
    enabled: canCreate && !isAgent,
    staleTime: 60_000,
  });

  const appts = data?.data ?? [];
  const summary = data?.summary;
  const byDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of appts) {
      const k = format(new Date(a.startsAt), "yyyy-MM-dd");
      const list = m.get(k) ?? [];
      list.push(a);
      m.set(k, list);
    }
    return m;
  }, [appts]);
  const dayAppts = (d: Date) => byDay.get(format(d, "yyyy-MM-dd")) ?? [];
  const selectedAppts = dayAppts(selected);

  const shift = (dir: 1 | -1) => {
    const next = view === "month" ? addMonths(anchor, dir) : view === "week" ? addWeeks(anchor, dir) : addDays(anchor, 30 * dir);
    setAnchor(next);
  };
  const goToday = () => {
    const now = new Date();
    setAnchor(now);
    setSelected(now);
  };
  const openNew = (date?: Date) => setDialog({ open: true, appt: null, date: date ?? selected });
  const openEdit = (appt: Appointment) => setDialog({ open: true, appt });

  const periodWord = view === "month" ? "this month" : view === "week" ? "this week" : "next 30 days";
  const scopeLabel = data?.scope === "own" || isAgent ? "My calendar" : agentId ? "One agent" : "All";

  const monthDays = useMemo(
    () => eachDayOfInterval({ start: startOfWeek(startOfMonth(anchor)), end: endOfWeek(endOfMonth(anchor)) }),
    [anchor],
  );
  const weekDays = useMemo(() => eachDayOfInterval({ start: startOfWeek(anchor), end: endOfWeek(anchor) }), [anchor]);

  return (
    <div className="space-y-6">
      <PageHeader title="Calendar & Appointments" subtitle="Book and manage client meetings and reviews">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
          <Eye className="h-3.5 w-3.5" /> Viewing: {scopeLabel}
        </span>
        {!isAgent && (agents.data?.data.length ?? 0) > 1 && (
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-9 w-44" aria-label="Filter by agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.data!.data.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.firstName} {a.lastName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="Calendar view">
          {(["month", "week", "agenda"] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={goToday}>Today</Button>
        {canCreate && (
          <Button onClick={() => openNew()}>
            <Plus className="mr-1.5 h-4 w-4" /> New Appointment
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label={`Total appointments ${periodWord}`} value={summary?.total ?? 0} className="text-navy-700 dark:text-foreground" loading={isLoading} />
        <StatTile label="Confirmed" value={summary?.confirmed ?? 0} className="text-success" loading={isLoading} />
        <StatTile label="Pending" value={summary?.pending ?? 0} className="text-warning" loading={isLoading} />
        <StatTile label="Completed" value={summary?.completed ?? 0} className="text-muted-foreground" loading={isLoading} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title={<span className="text-2xl font-bold">{rangeTitle(view, anchor)}</span>}
          description={view === "agenda" ? "Everything coming up, in order" : "Click a day to view appointments"}
          actions={
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(-1)} aria-label="Previous">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(1)} aria-label="Next">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          }
        >
          {isError && (
            <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              Could not load appointments. Refresh to try again.
            </p>
          )}

          {view === "month" && (
            <>
              <div className="mb-2 grid grid-cols-7 gap-1.5">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {monthDays.map((day) => {
                  const list = dayAppts(day);
                  const inMonth = isSameMonth(day, anchor);
                  const isSel = isSameDay(day, selected);
                  const today = isToday(day);
                  return (
                    <button
                      key={day.toISOString()}
                      onClick={() => setSelected(day)}
                      onDoubleClick={() => canCreate && openNew(day)}
                      aria-label={`${format(day, "EEEE, MMMM d")}: ${list.length} appointment${list.length === 1 ? "" : "s"}`}
                      aria-pressed={isSel}
                      className={cn(
                        "relative flex aspect-square flex-col items-center justify-center rounded-lg border text-sm transition-colors",
                        isSel ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-border hover:border-accent/40 hover:bg-muted/40",
                        !inMonth && "opacity-30",
                        today && !isSel && "border-accent/50 bg-accent/5",
                      )}
                    >
                      <span className={cn("font-medium", today && "text-accent")}>{format(day, "d")}</span>
                      {list.length > 0 && (
                        <span className="mt-1 flex gap-0.5">
                          {list.slice(0, 3).map((a) => (
                            <span key={a.id} className={cn("h-1.5 w-1.5 rounded-full", TYPE_DOT[a.type])} />
                          ))}
                          {list.length > 3 && <span className="text-[9px] leading-none text-muted-foreground">+{list.length - 3}</span>}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {view === "week" && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
              {weekDays.map((day) => {
                const list = dayAppts(day);
                const isSel = isSameDay(day, selected);
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      "flex min-h-[220px] flex-col rounded-lg border p-2",
                      isSel ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border",
                    )}
                  >
                    <button onClick={() => setSelected(day)} className="mb-2 text-left">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{format(day, "EEE")}</p>
                      <p className={cn("font-display text-lg font-bold", isToday(day) && "text-accent")}>{format(day, "d")}</p>
                    </button>
                    <div className="space-y-1.5">
                      {list.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => openEdit(a)}
                          className={cn("w-full rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight", TYPE_CHIP[a.type])}
                        >
                          <span className="block font-semibold">{format(new Date(a.startsAt), "h:mm a")}</span>
                          <span className="block truncate">{personName(a.contact) ?? a.title}</span>
                        </button>
                      ))}
                      {list.length === 0 && canCreate && (
                        <button
                          onClick={() => openNew(day)}
                          className="w-full rounded-md border border-dashed border-border py-2 text-[11px] text-muted-foreground hover:border-accent/40 hover:text-foreground"
                        >
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {view === "agenda" && (
            <div className="space-y-5">
              {isLoading ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
              ) : appts.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  title="Nothing booked in the next 30 days"
                  description="Appointments you book show up here in date order."
                  action={canCreate ? { label: "Book an appointment", onClick: () => openNew() } : undefined}
                />
              ) : (
                Array.from(byDay.entries()).map(([key, list]) => (
                  <div key={key}>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {isToday(new Date(`${key}T00:00`)) ? "Today · " : ""}
                      {format(new Date(`${key}T00:00`), "EEEE, MMMM d")}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {list.map((a) => <AppointmentCard key={a.id} appt={a} onClick={() => openEdit(a)} />)}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard
            title={<span className="text-2xl font-bold">{isToday(selected) ? "Today" : format(selected, "EEEE")}</span>}
            description={format(selected, "MMMM d, yyyy")}
          >
            <div className="space-y-3">
              {isLoading ? (
                <Skeleton className="h-24" />
              ) : selectedAppts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <Clock className="mb-3 h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No appointments scheduled</p>
                  {canCreate && (
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => openNew(selected)}>
                      <Plus className="mr-1.5 h-4 w-4" /> Schedule one
                    </Button>
                  )}
                </div>
              ) : (
                selectedAppts.map((a) => <AppointmentCard key={a.id} appt={a} onClick={() => openEdit(a)} />)
              )}

              <div className="border-t border-border pt-3">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">Appointment Types</p>
                <div className="flex flex-wrap gap-2">
                  {APPOINTMENT_TYPES.filter((t) => t !== "other").map((t) => (
                    <span key={t} className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", TYPE_CHIP[t])}>
                      {TYPE_LABELS[t]}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </SectionCard>

          <div className="rounded-xl border border-dashed border-border bg-card/60 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
                <CalendarSync className="h-5 w-5" />
              </div>
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold">
                  Google & Outlook sync
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-warning">Coming soon</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Two-way sync with Google Calendar and Microsoft 365 is on the way. Until then, book here —
                  clients still get an automatic reminder the day before by text or email.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AppointmentDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        appointment={dialog.appt}
        defaults={{ date: dialog.date }}
        canDelete={canDelete}
        onSaved={(a) => setSelected(new Date(a.startsAt))}
      />
    </div>
  );
}
