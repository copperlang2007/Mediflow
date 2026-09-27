/**
 * Client Portal — staff-facing "Preview as <client>".
 *
 * Member logins are not built yet. This page shows a signed-in staff member
 * exactly what one client will see once they are: their profile, their plan
 * (from real enrollments), their real SMS/email thread with the agency, the
 * documents filed against them, upcoming appointments (when the appointments
 * API exists in this build) and how to reach their agent.
 *
 * Opening a preview is a PHI view: the API requires `contact:read` (same as
 * the contact page) and writes an audit_log row before returning anything.
 * Replying uses the existing send-SMS / send-email endpoints and only shows
 * when the viewer is allowed to send.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  CalendarDays, Download, ExternalLink, FileText, Globe, Lock, Mail, MessageSquare,
  Phone, Send, ShieldCheck, UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { ComingSoonNote, ContactPicker, NoAccess, SoonBadge } from "@/components/portal-dialer";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CONTACT_READ_ROLES,
  formatPhone,
  initialsOf,
  portalPreviewKey,
  useContactAppointments,
  usePortalPreview,
  type PortalMessage,
  type PortalPlan,
} from "@/lib/portalDialer/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const PLAN_TYPE_LABEL: Record<string, string> = {
  MA: "Medicare Advantage",
  MAPD: "Medicare Advantage + Drug",
  PDP: "Part D drug plan",
  supp: "Medicare Supplement",
  other: "Other coverage",
};

function parseDay(d: string): Date {
  // `date` columns come back as "YYYY-MM-DD"; read them as local calendar days.
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, day ?? 1);
}

/**
 * When the member's coverage next renews. Medicare Advantage and Part D plans
 * renew with the plan year on January 1; a Medicare Supplement renews on its
 * policy anniversary. Ended coverage has no renewal.
 */
export function nextRenewal(plan: Pick<PortalPlan, "planType" | "planYear" | "effectiveDate" | "status">, today = new Date()): { label: string; date: Date } | null {
  if (["terminated", "cancelled", "declined"].includes(plan.status)) return null;
  if (plan.planType === "supp" || plan.planType === "other") {
    const eff = parseDay(plan.effectiveDate);
    const next = new Date(today.getFullYear(), eff.getMonth(), eff.getDate());
    if (next <= today) next.setFullYear(next.getFullYear() + 1);
    return { label: "Policy anniversary", date: next };
  }
  return { label: "Plan year renews", date: new Date(plan.planYear + 1, 0, 1) };
}

function pickPrimaryPlan(plans: PortalPlan[]): PortalPlan | null {
  return (
    plans.find((p) => p.status === "active") ??
    plans.find((p) => p.status === "pending") ??
    plans[0] ??
    null
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function MessageBubble({ m, agentInitials, clientInitials }: { m: PortalMessage; agentInitials: string; clientInitials: string }) {
  const fromClient = m.direction === "inbound";
  const at = m.sentAt ?? m.createdAt;
  return (
    <div className={cn("flex items-end gap-2", fromClient && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
          fromClient ? "bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground" : "bg-navy-800 text-white",
        )}
        aria-hidden="true"
      >
        {fromClient ? clientInitials : agentInitials}
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm",
          fromClient ? "bg-muted rounded-br-sm" : "bg-accent/10 rounded-bl-sm",
        )}
      >
        {m.channel === "email" && m.subject && <p className="mb-0.5 font-semibold">{m.subject}</p>}
        <p className="whitespace-pre-wrap break-words">{m.body || <span className="italic text-muted-foreground">(no text)</span>}</p>
        <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          {m.channel === "email" ? <Mail className="h-2.5 w-2.5" /> : <MessageSquare className="h-2.5 w-2.5" />}
          {format(new Date(at), "MMM d, h:mm a")}
          {m.status === "failed" && <span className="text-destructive">· not delivered</span>}
        </span>
      </div>
    </div>
  );
}

function ReplyBox({ contactId, canSms, canEmail }: { contactId: string; canSms: boolean; canEmail: boolean }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<"sms" | "email">(canSms ? "sms" : "email");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);

  if (!canSms && !canEmail) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        Replying is off for you here — either your role can't send messages or this client has opted out.
      </p>
    );
  }

  const send = async () => {
    if (!body.trim() || (channel === "email" && !subject.trim())) return;
    setSending(true);
    try {
      if (channel === "sms") {
        await apiRequest(`/api/contacts/${contactId}/send-sms`, { method: "POST", body: JSON.stringify({ body }) });
      } else {
        await apiRequest(`/api/contacts/${contactId}/send-email`, { method: "POST", body: JSON.stringify({ subject, body }) });
      }
      toast.success(channel === "sms" ? "Text message sent" : "Email sent");
      setBody("");
      setSubject("");
      void qc.invalidateQueries({ queryKey: portalPreviewKey(contactId) });
    } catch (err) {
      toast.error((err as Error).message || "Couldn't send the message");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      {canSms && canEmail && (
        <div className="inline-flex rounded-lg bg-muted p-0.5 text-xs" role="tablist" aria-label="Reply channel">
          {(["sms", "email"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={channel === c}
              onClick={() => setChannel(c)}
              className={cn("rounded-md px-2.5 py-1 font-medium", channel === c ? "bg-card shadow-sm" : "text-muted-foreground")}
            >
              {c === "sms" ? "Text" : "Email"}
            </button>
          ))}
        </div>
      )}
      {channel === "email" && (
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Email subject" />
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={channel === "sms" ? "Type a text message…" : "Type an email…"}
          rows={2}
          className="min-h-[44px] resize-none"
          aria-label="Reply"
        />
        <Button onClick={send} disabled={sending || !body.trim() || (channel === "email" && !subject.trim())} aria-label="Send reply" className="h-11 w-11 shrink-0 p-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Replies are sent for real, from your agency, as a {channel === "sms" ? "text message" : "email"}.
      </p>
    </div>
  );
}

export default function ClientPortalPage() {
  const { role, isLoading: roleLoading } = useIsAdmin(CONTACT_READ_ROLES);
  const search = useSearch();
  const [, navigate] = useLocation();
  const contactId = useMemo(() => new URLSearchParams(search).get("contact"), [search]);

  const allowed = !!role && (CONTACT_READ_ROLES as readonly string[]).includes(role);
  const { data, isLoading, isError, error } = usePortalPreview(allowed ? contactId : null);
  const appts = useContactAppointments(allowed && data ? contactId : null);

  const select = (id: string) => navigate(`/client-portal?contact=${encodeURIComponent(id)}`, { replace: true });

  // Keep the thread scrolled to the newest message (inside its own box only).
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length]);

  if (!roleLoading && role && !allowed) return <NoAccess what="the client portal preview" />;

  const c = data?.contact;
  const plan = data ? pickPrimaryPlan(data.plans) : null;
  const otherPlans = data && plan ? data.plans.filter((p) => p.id !== plan.id) : [];
  const renewal = plan ? nextRenewal(plan) : null;
  const clientInitials = c ? initialsOf(c.firstName, c.lastName) : "?";
  const agentInitials = data?.agent ? initialsOf(data.agent.firstName, data.agent.lastName) : "AG";

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Client Portal"
        subtitle="Beneficiary self-service portal preview — see exactly what a client sees: their plan, messages with you, and their documents"
      />

      <ComingSoonNote title="Client logins are coming soon — this is exactly what your client will see." icon={Globe}>
        Pick a client below to preview their portal with their real plan, messages and documents.
        Opening a preview is recorded in the audit log, just like opening their contact record.
      </ComingSoonNote>

      <SectionCard contentClassName="py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <span className="text-sm font-medium shrink-0">Preview as:</span>
          <ContactPicker className="md:w-80" onSelect={(ct) => select(ct.id)} placeholder={c ? `${c.firstName} ${c.lastName} — search to switch` : "Search clients by name, phone or email…"} />
          {c && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{c.firstName} {c.lastName}</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                <ShieldCheck className="h-3 w-3" /> Private view · audited
              </span>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/crm/contacts/${c.id}`}>
                  Open contact record <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      {!contactId ? (
        <SectionCard>
          <EmptyState
            icon={UserRound}
            title="Pick a client to preview"
            description="Search for any client above. You'll see their portal exactly as they will — nothing here is sample data."
          />
        </SectionCard>
      ) : isError ? (
        <SectionCard>
          <EmptyState
            icon={UserRound}
            title={(error as Error & { status?: number })?.status === 404 ? "That client wasn't found" : "Couldn't load this preview"}
            description={(error as Error & { status?: number })?.status === 404 ? "They may have been removed. Search for someone else above." : "Please try again in a moment."}
          />
        </SectionCard>
      ) : isLoading || !data || !c ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-96 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left — profile + plan */}
          <div className="space-y-6">
            <SectionCard contentClassName="py-6 text-center">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-navy-100 font-display text-lg font-semibold text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
                {clientInitials}
              </div>
              <p className="font-display text-base font-bold">{c.firstName} {c.lastName}</p>
              {c.email && <p className="text-xs text-muted-foreground">{c.email}</p>}
              {c.phone && <p className="text-xs text-muted-foreground">{formatPhone(c.phone)}</p>}
              {(c.city || c.stateCode) && (
                <p className="text-xs text-muted-foreground">{[c.city, c.stateCode, c.zipCode].filter(Boolean).join(", ")}</p>
              )}
              <div className="mt-2 flex justify-center"><StatusPill status={c.status} /></div>
            </SectionCard>

            <SectionCard title="My Plan" contentClassName="pt-0">
              {plan ? (
                <div className="divide-y divide-border/60">
                  <Row label="Carrier">{plan.carrierName ?? "—"}</Row>
                  <Row label="Plan type">{PLAN_TYPE_LABEL[plan.planType] ?? plan.planType}</Row>
                  {plan.planName && <Row label="Plan">{plan.planName}</Row>}
                  <Row label="Status"><StatusPill status={plan.status} /></Row>
                  <Row label="Effective">{format(parseDay(plan.effectiveDate), "MMM d, yyyy")}</Row>
                  {renewal ? (
                    <Row label={renewal.label}>{format(renewal.date, "MMM d, yyyy")}</Row>
                  ) : plan.disenrolledDate ? (
                    <Row label="Ended">{format(parseDay(plan.disenrolledDate), "MMM d, yyyy")}</Row>
                  ) : null}
                  <Row label="Agent">
                    {plan.agentFirstName ? `${plan.agentFirstName} ${plan.agentLastName ?? ""}`.trim() : "—"}
                  </Row>
                </div>
              ) : (
                <EmptyState compact icon={FileText} title="No plan on file yet" description="Once an enrollment is recorded for this client, their plan shows here." />
              )}
              {otherPlans.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other coverage</p>
                  <ul className="space-y-1.5 text-sm">
                    {otherPlans.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {p.planYear} · {p.carrierName ?? "Carrier unknown"} · {p.planType}
                        </span>
                        <StatusPill status={p.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </SectionCard>
          </div>

          {/* Middle — messages */}
          <SectionCard title="Messages" icon={MessageSquare} className="flex flex-col" contentClassName="flex flex-1 flex-col">
            <div ref={threadRef} className="mb-4 max-h-[440px] min-h-[260px] flex-1 space-y-3 overflow-y-auto pr-1">
              {data.messages.length === 0 ? (
                <EmptyState compact icon={MessageSquare} title="No messages yet" description="Texts and emails between your agency and this client will appear here." />
              ) : (
                data.messages.map((m) => (
                  <MessageBubble key={m.id} m={m} agentInitials={agentInitials} clientInitials={clientInitials} />
                ))
              )}
            </div>
            <ReplyBox contactId={c.id} canSms={data.permissions.canReplySms} canEmail={data.permissions.canReplyEmail} />
          </SectionCard>

          {/* Right — documents, appointments, agent */}
          <div className="space-y-6">
            <SectionCard title="Documents" icon={FileText} contentClassName="pt-0">
              {data.documents.length === 0 ? (
                <EmptyState compact icon={FileText} title="No documents shared yet" description="Documents filed against this client (SOA, applications, letters) will show here." />
              ) : (
                <ul className="divide-y divide-border/60">
                  {data.documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate">{d.name}</span>
                          <span className="block text-[11px] text-muted-foreground">Added {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}</span>
                        </span>
                      </span>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" asChild>
                        <a href={`${BASE}/api/documents/${d.id}/download`} aria-label={`Download ${d.name}`}>
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Upcoming Appointments" icon={CalendarDays} contentClassName="pt-0 space-y-3">
              {appts.isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : appts.data?.available ? (
                appts.data.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing booked yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {appts.data.items.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 text-sm">
                        <div className="rounded-lg bg-accent/10 p-2 text-accent"><CalendarDays className="h-4 w-4" /></div>
                        <div>
                          <p className="font-medium">{a.title}</p>
                          <p className="text-xs text-muted-foreground">{format(new Date(a.startsAt), "MMM d, yyyy · h:mm a")}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Appointment booking is coming soon. Your client will see their upcoming plan reviews here.
                </p>
              )}
              <Button variant="outline" size="sm" className="w-full" disabled>
                <CalendarDays className="mr-1.5 h-3.5 w-3.5" /> Schedule New Appointment <span className="ml-2"><SoonBadge>Client action</SoonBadge></span>
              </Button>
            </SectionCard>

            <SectionCard title="Contact Agent" icon={Phone} contentClassName="pt-0 space-y-2">
              {data.agent ? (
                <>
                  <p className="text-sm font-medium">{data.agent.firstName} {data.agent.lastName}</p>
                  {data.agent.phone && (
                    <p className="flex items-center gap-2 text-sm"><Phone className="h-3.5 w-3.5 text-muted-foreground" /> {formatPhone(data.agent.phone)}</p>
                  )}
                  <p className="flex items-center gap-2 text-sm break-all"><Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {data.agent.email}</p>
                  <Button variant="outline" size="sm" className="w-full" disabled>
                    <Phone className="mr-1.5 h-3.5 w-3.5" /> Call Agent <span className="ml-2"><SoonBadge>Client action</SoonBadge></span>
                  </Button>
                </>
              ) : (
                <EmptyState compact icon={UserRound} title="No agent assigned" description="Assign an agent on the contact record so the client knows who to reach." />
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
