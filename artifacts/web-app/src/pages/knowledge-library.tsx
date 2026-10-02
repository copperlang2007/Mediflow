/**
 * Mediflow library — the part of the Knowledge Base that belongs to the whole
 * platform. Every agency sees the same articles; each agency chooses which
 * ones to use. `/api/kb/library` lists them with this agency's on/off state,
 * `/api/kb/library/choices` saves a choice (agency owners only). Switched-on
 * articles are also handed to the AI assistant when a question matches them.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, Search, Sparkles, Tag } from "lucide-react";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, MiniStat, PageHeader, StatusPill } from "@/components/shared";
import { cn } from "@/lib/utils";

type LibraryArticle = {
  id: string;
  category: string;
  title: string;
  content: string;
  keywords: string[];
  kind: "mediflow_guide" | "medicare_reference";
  needsReview: boolean;
  defaultEnabled: boolean;
  enabled: boolean;
  chosen: boolean;
};

type LibraryResponse = { articles: LibraryArticle[]; stats: { total: number; enabled: number } };

const EDITOR_ROLES = ["super_admin", "agency_admin"];
const ALL = "all";

export function KnowledgeLibrary({ viewSwitch }: { viewSwitch: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const canEdit = EDITOR_ROLES.includes(me?.role ?? "");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState(ALL);
  const [confirm, setConfirm] = useState<{ ids: string[]; reviewCount: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (kind !== ALL) params.set("kind", kind);
  const qs = params.toString();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["/api/kb/library", qs],
    queryFn: () => customFetch<LibraryResponse>(`/api/kb/library${qs ? `?${qs}` : ""}`),
  });
  const articles = data?.articles ?? [];

  const save = async (ids: string[], enabled: boolean) => {
    setSaving(true);
    try {
      await customFetch("/api/kb/library/choices", { method: "PUT", body: JSON.stringify({ ids, enabled }) });
      void qc.invalidateQueries({ queryKey: ["/api/kb/library"] });
      toast({ title: enabled ? "Switched on" : "Switched off", description: `${ids.length} article${ids.length === 1 ? "" : "s"} updated for your agency.` });
    } catch {
      toast({ title: "Couldn't save that", description: "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Notes flagged "needs review" ask for a second confirmation before they go on.
  const switchOn = (items: LibraryArticle[]) => {
    const ids = items.filter((a) => !a.enabled).map((a) => a.id);
    if (ids.length === 0) return;
    const reviewCount = items.filter((a) => !a.enabled && a.needsReview).length;
    if (reviewCount > 0) setConfirm({ ids, reviewCount });
    else void save(ids, true);
  };
  const switchOff = (items: LibraryArticle[]) => {
    const ids = items.filter((a) => a.enabled).map((a) => a.id);
    if (ids.length > 0) void save(ids, false);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Knowledge Base"
        subtitle="Articles from Mediflow, shared with every agency. Switch on the ones you want your team and the AI assistant to use."
      >
        {viewSwitch}
      </PageHeader>

      <div className="grid grid-cols-2 gap-4">
        <MiniStat label="In the library" value={data?.stats.total ?? 0} icon={BookOpen} loading={isLoading} />
        <MiniStat label="Switched on for you" value={data?.stats.enabled ?? 0} icon={Sparkles} loading={isLoading} tone="success" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search the library…" className="pl-9" aria-label="Search the library" />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-[240px]" aria-label="Type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All articles</SelectItem>
            <SelectItem value="mediflow_guide">How Mediflow works</SelectItem>
            <SelectItem value="medicare_reference">General Medicare notes</SelectItem>
          </SelectContent>
        </Select>
        {canEdit && articles.length > 0 && (
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="outline" size="sm" disabled={saving} onClick={() => switchOn(articles)}>Switch on all shown</Button>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => switchOff(articles)}>Switch off all shown</Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>
      ) : isError ? (
        <div className="rounded-xl border border-border bg-card"><EmptyState icon={BookOpen} title="Couldn't load the library" description="Please refresh the page." /></div>
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-border bg-card"><EmptyState icon={Search} title="No articles match" description="Try a different word." /></div>
      ) : (
        <div className="space-y-3">
          {articles.map((a) => (
            <article key={a.id} className={cn("rounded-xl border border-border bg-card p-4 shadow-sm", !a.enabled && "opacity-70")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                      <Tag className="h-3 w-3" /> {a.category}
                    </span>
                    {a.needsReview && (
                      <StatusPill tone="warning"><AlertTriangle className="mr-1 h-3 w-3" /> Check before using</StatusPill>
                    )}
                    <StatusPill tone={a.enabled ? "success" : "neutral"}>{a.enabled ? "On" : "Off"}</StatusPill>
                  </div>
                  <h3 className="font-display text-base font-semibold">{a.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-3 whitespace-pre-line">{a.content}</p>
                  {a.needsReview && (
                    <p className="mt-2 text-xs text-muted-foreground">Written in 2025 — some figures or rules may have changed. Check it against current guidance before relying on it.</p>
                  )}
                </div>
                {canEdit && (
                  <Switch
                    checked={a.enabled}
                    disabled={saving}
                    onCheckedChange={(on) => (on ? switchOn([a]) : switchOff([a]))}
                    aria-label={a.enabled ? "Switch off" : "Switch on"}
                  />
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch on notes that need checking?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.reviewCount} of these {confirm?.reviewCount === 1 ? "note was" : "notes were"} written in 2025 and some figures or rules may be out of date. Your team and the AI assistant will use them as written. You can switch them off again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const ids = confirm?.ids ?? []; setConfirm(null); void save(ids, true); }}>Switch on</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
