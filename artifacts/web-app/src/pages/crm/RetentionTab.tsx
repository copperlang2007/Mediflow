import { useState } from "react";
import { useLocation } from "wouter";
import type {
  Contact, RetentionSummary,
} from "@workspace/api-client-react";
import {
  useGetRetentionBirthdays, useGetRetentionAtRisk, useGetRetentionAep, useGetRetentionSummary,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ChevronRight, AlertTriangle, Calendar, Cake,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { CONTACT_STATUS_STYLES, PLAN_TYPE_LABELS, initials } from "./shared";

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
    <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/20 cursor-pointer" onClick={() => nav(`/crm/contacts/${c.id}`)}>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials(c.firstName, c.lastName)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{c.firstName} {c.lastName}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          {c.currentPlanType && <span>{PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}</span>}
          {c.dob && section === "birthdays" && <span>{format(new Date(c.dob), "MMMM d")}</span>}
          {c.stateCode && <span>{c.stateCode}</span>}
        </div>
      </div>
      <Badge className={cn("text-xs border-0 shrink-0", CONTACT_STATUS_STYLES[c.status] ?? "")}>{c.status}</Badge>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "birthdays" && "ring-2 ring-primary")} onClick={() => setSection("birthdays")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <Cake className="h-8 w-8 text-pink-500 shrink-0" />
            <div><p className="text-xl font-bold">{String(summary?.birthdaysInNext30Days ?? "—")}</p><p className="text-xs text-muted-foreground">Birthdays (30d)</p></div>
          </CardContent>
        </Card>
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "at_risk" && "ring-2 ring-primary")} onClick={() => setSection("at_risk")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-amber-500 shrink-0" />
            <div><p className="text-xl font-bold">{String(summary?.atRiskContacts ?? "—")}</p><p className="text-xs text-muted-foreground">At-Risk (60d)</p></div>
          </CardContent>
        </Card>
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "aep" && "ring-2 ring-primary")} onClick={() => setSection("aep")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <Calendar className="h-8 w-8 text-blue-500 shrink-0" />
            <div><p className="text-xl font-bold">{aep.length}</p><p className="text-xs text-muted-foreground">AEP Eligible</p></div>
          </CardContent>
        </Card>
      </div>

      {section === "birthdays" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><Cake className="h-4 w-4 text-pink-500" />Upcoming Birthdays — Next 30 Days</p>
          {bLoading ? <Skeleton className="h-32 rounded-xl" /> : birthdays.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No birthdays in the next 30 days</div>
          ) : <div className="space-y-2">{birthdays.map(renderContactRow)}</div>}
        </div>
      )}

      {section === "at_risk" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />At-Risk Contacts — No activity in 60+ days</p>
          {arLoading ? <Skeleton className="h-32 rounded-xl" /> : atRisk.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No at-risk contacts</div>
          ) : <div className="space-y-2">{atRisk.map(renderContactRow)}</div>}
        </div>
      )}

      {section === "aep" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><Calendar className="h-4 w-4 text-blue-500" />AEP-Eligible Contacts</p>
          {aepLoading ? <Skeleton className="h-32 rounded-xl" /> : aep.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No AEP-eligible contacts found</div>
          ) : <div className="space-y-2">{aep.map(renderContactRow)}</div>}
        </div>
      )}
    </div>
  );
}
