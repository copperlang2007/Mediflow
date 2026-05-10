import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Users, Inbox, Workflow, Shield, Target, TrendingUp,
} from "lucide-react";
import ContactsTab from "@/pages/crm/ContactsTab";
import LeadsTab from "@/pages/crm/LeadsTab";
import PipelineTab from "@/pages/crm/PipelineTab";
import InboxTab from "@/pages/crm/InboxTab";
import SequencesTab from "@/pages/crm/SequencesTab";
import RetentionTab from "@/pages/crm/RetentionTab";

// ──────────────────────────────────────────────
// Main CRM Page
// ──────────────────────────────────────────────

export default function CRMPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Contacts, leads, pipelines, inbox, sequences, and retention</p>
      </div>
      <Tabs defaultValue="contacts" className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1 bg-muted/40 p-1">
          <TabsTrigger value="contacts" className="gap-1.5"><Users className="h-4 w-4" />Contacts</TabsTrigger>
          <TabsTrigger value="leads" className="gap-1.5"><Target className="h-4 w-4" />Leads</TabsTrigger>
          <TabsTrigger value="pipeline" className="gap-1.5"><TrendingUp className="h-4 w-4" />Pipeline</TabsTrigger>
          <TabsTrigger value="inbox" className="gap-1.5"><Inbox className="h-4 w-4" />Inbox</TabsTrigger>
          <TabsTrigger value="sequences" className="gap-1.5"><Workflow className="h-4 w-4" />Sequences</TabsTrigger>
          <TabsTrigger value="retention" className="gap-1.5"><Shield className="h-4 w-4" />Retention</TabsTrigger>
        </TabsList>
        <TabsContent value="contacts"><ContactsTab /></TabsContent>
        <TabsContent value="leads"><LeadsTab /></TabsContent>
        <TabsContent value="pipeline"><PipelineTab /></TabsContent>
        <TabsContent value="inbox"><InboxTab /></TabsContent>
        <TabsContent value="sequences"><SequencesTab /></TabsContent>
        <TabsContent value="retention"><RetentionTab /></TabsContent>
      </Tabs>
    </div>
  );
}
