import { useState } from "react";
import { useLocation } from "wouter";
import type {
  Contact, RetentionSummary,
} from "@workspace/api-client-react";
import {
  useGetRetentionBirthdays, useGetRetentionAtRisk, useGetRetentionAep, useGetRetentionSummary,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronRight, AlertTriangle, Calendar, Cake,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { EmptyState, MiniStat, SectionCard, StatusPill } from "@/components/shared";
import { PLAN_TYPE_LABELS } from "./shared";
import { ContactAvatar } from "./ui";

export default function RetentionTab() {
  const [, nav] = useLocation();
  const [section, setSection] = useState<"birthdays" | "at_risk" | "aep">("birthdays");

  const { data: summaryRaw } = useGetRetentionSummary();
  const { data: birthdaysRaw, isLoading: bLoading } = useGetRetentionBirthdays({ days: 30 });
  const { data: atRiskRaw, isLoading: arLoading } = useGetRetentionAtRisk({ days: 60 });
  const { data: aepRaw, isLoading: aepLoading } = useGetRetentionAep({});

  const summary = summaryRaw as RetentionSummary | undefined;
  const birthdays: Contact[] = birthdaysRaw ?? [];
  const atRisk: Contact[] = atRiskRaw ?? [];
  const aep: Contact[] = aepRaw ?? [];

  const renderContactRow = (c: Contact) => (
    <button
      type="button"
      key={c.id}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      onClick={() => nav(`/crm/contacts/${c.id}`)}
    >
      <ContactAvatar first={c.firstName} last={c.lastName} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{c.firstName} {c.lastName}</p>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground mt-0.5">
          {c.dob && section === "birthdays" && <span className="font-medium text-foreground">Birthday {format(new Date(c.dob), "MMMM d")}</span>}
          {c.currentPlanType && <span>{PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}</span>}
          {c.stateCode && <span>{c.stateCode}</span>}
        </div>
      </div>
      <StatusPill status={c.status} className="shrink-0" />
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );

  const SECTIONS = [
    {
      key: "birthdays" as const,
      icon: Cake,
      label: "Birthdays in the next 30 days",
      value: summary?.birthdaysInNext30Days,
      title: "Upcoming birthdays",
      description: "A quick call or card on their birthday goes a long way.",
      rows: birthdays,
      loading: bLoading,
      empty: "No client birthdays in the next 30 days.",
    },
    {
      key: "at_risk" as const,
      icon: AlertTriangle,
      label: "No contact in 60+ days",
      value: summary?.atRiskContacts,
      title: "Clients you haven't talked to lately",
      description: "No calls, texts or emails logged in the last 60 days. A check-in helps keep them.",
      rows: atRisk,
      loading: arLoading,
      empty: "Everyone has heard from you in the last 60 days.",
    },
    {
      key: "aep" as const,
      icon: Calendar,
      label: "Eligible for AEP review",
      value: aepLoading ? undefined : aep.length,
      title: "AEP review list",
      description: "Clients to review with during the Annual Enrollment Period.",
      rows: aep,
      loading: aepLoading,
      empty: "No AEP-eligible clients found.",
    },
  ];
  const current = SECTIONS.find((x) => x.key === section) ?? SECTIONS[0];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {SECTIONS.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setSection(x.key)}
            aria-pressed={section === x.key}
            className={cn(
              "rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              section === x.key && "ring-2 ring-accent",
            )}
          >
            <MiniStat
              icon={x.icon}
              label={x.label}
              value={x.value ?? "—"}
              tone={x.key === "at_risk" && (x.value ?? 0) > 0 ? "warning" : "default"}
              className="hover:shadow-md"
            />
          </button>
        ))}
      </div>

      <SectionCard title={current.title} description={current.description} icon={current.icon} contentClassName="px-0 pb-2">
        {current.loading ? (
          <div className="space-y-2 px-5 pb-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : current.rows.length === 0 ? (
          <EmptyState compact icon={current.icon} title="Nothing to do here" description={current.empty} />
        ) : (
          <div className="divide-y divide-border border-t border-border">{current.rows.map(renderContactRow)}</div>
        )}
      </SectionCard>
    </div>
  );
}
