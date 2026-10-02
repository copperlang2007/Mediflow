/**
 * Mediflow library — the part of the Knowledge Base that belongs to the whole
 * platform. Every agency sees the same articles; each agency chooses which
 * ones to use. `/api/kb/library` lists them with this agency's on/off state,
 * `/api/kb/library/choices` saves a choice (agency owners only). Switched-on
 * articles are also handed to the AI assistant when a question matches them.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, Pencil, Plus, Search, ShieldAlert, Sparkles, Tag, Trash2 } from "lucide-react";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
/** Only the platform owner can change the shared library itself. */
const PLATFORM_ROLE = "super_admin";
const ALL = "all";

type EditorState = {
  id?: string;
  category: string;
  title: string;
  content: string;
  keywords: string;
  kind: LibraryArticle["kind"];
  defaultEnabled: boolean;
  needsReview: boolean;
};
const EMPTY: EditorState = {
  category: "",
  title: "",
  content: "",
  keywords: "",
  kind: "mediflow_guide",
  defaultEnabled: true,
  needsReview: false,
};

export function KnowledgeLibrary({ viewSwitch }: { viewSwitch: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const canEdit = EDITOR_ROLES.includes(me?.role ?? "");
  const isPlatformOwner = me?.role === PLATFORM_ROLE;

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState(ALL);
  const [confirm, setConfirm] = useState<{ ids: string[]; reviewCount: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryArticle | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const refresh = () => void qc.invalidateQueries({ queryKey: ["/api/kb/library"] });

  const saveArticle = async () => {
    if (!editor) return;
    if (!editor.title.trim() || !editor.content.trim() || !editor.category.trim()) {
      toast({ title: "Almost there", description: "Category, title and the article text are all needed.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        category: editor.category.trim(),
        title: editor.title.trim(),
        content: editor.content.trim(),
        keywords: editor.keywords.split(",").map((k) => k.trim()).filter(Boolean),
        kind: editor.kind,
        defaultEnabled: editor.defaultEnabled,
        needsReview: editor.needsReview,
      });
      if (editor.id) await customFetch(`/api/kb/library/articles/${editor.id}`, { method: "PATCH", body });
      else await customFetch("/api/kb/library/articles", { method: "POST", body });
      toast({ title: editor.id ? "Saved for every agency" : "Added to the library" });
      setEditor(null);
      refresh();
    } catch {
      toast({ title: "Couldn't save that", description: "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await customFetch(`/api/kb/library/articles/${deleteTarget.id}`, { method: "DELETE" });
      toast({ title: "Removed from the library" });
      refresh();
    } catch {
      toast({ title: "Couldn't remove that", variant: "destructive" });
    } finally {
      setDeleteTarget(null);
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
        {isPlatformOwner && (
          <Button size="sm" onClick={() => setEditor({ ...EMPTY })}>
            <Plus className="mr-1.5 h-4 w-4" /> Add library article
          </Button>
        )}
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
                  <p id={`kb-lib-${a.id}`} className={cn("mt-1 text-sm text-muted-foreground whitespace-pre-line", !expanded.has(a.id) && "line-clamp-3")}>{a.content}</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0 py-1 text-xs"
                    aria-expanded={expanded.has(a.id)}
                    aria-controls={`kb-lib-${a.id}`}
                    onClick={() => toggleExpanded(a.id)}
                  >
                    {expanded.has(a.id) ? "Show less" : "Read the full article"}
                  </Button>
                  {a.needsReview && (
                    <p className="mt-2 text-xs text-muted-foreground">Written in 2025 — some figures or rules may have changed. Check it against current guidance before relying on it.</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canEdit && (
                    <Switch
                      checked={a.enabled}
                      disabled={saving}
                      onCheckedChange={(on) => (on ? switchOn([a]) : switchOff([a]))}
                      aria-label={a.enabled ? "Switch off" : "Switch on"}
                    />
                  )}
                  {isPlatformOwner && (
                    <>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit for every agency"
                        onClick={() => setEditor({ id: a.id, category: a.category, title: a.title, content: a.content, keywords: a.keywords.join(", "), kind: a.kind, defaultEnabled: a.defaultEnabled, needsReview: a.needsReview })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label="Remove from the library" onClick={() => setDeleteTarget(a)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={editor !== null} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">{editor?.id ? "Edit library article" : "Add library article"}</DialogTitle>
            <DialogDescription>Write it the way you'd explain it to a new agent.</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
                <span>Changes here reach <strong>every agency</strong> and the AI assistant. Agencies that already chose on or off keep their choice. Never put client information in an article.</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="kbl-category">Category</Label>
                  <Input id="kbl-category" value={editor.category} onChange={(e) => setEditor({ ...editor, category: e.target.value })} placeholder="e.g. Mediflow Guide: Sales Tools" className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="kbl-title">Title</Label>
                  <Input id="kbl-title" value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="kbl-content">Article</Label>
                <Textarea id="kbl-content" rows={10} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })} className="mt-1" />
                <p className="mt-1 text-xs text-muted-foreground">{editor.content.length.toLocaleString()} characters. The assistant reads the first 1,500.</p>
              </div>
              <div>
                <Label htmlFor="kbl-keywords">Keywords</Label>
                <Input id="kbl-keywords" value={editor.keywords} onChange={(e) => setEditor({ ...editor, keywords: e.target.value })} placeholder="aep, switching, oep (separate with commas)" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="kbl-kind">Type</Label>
                <Select value={editor.kind} onValueChange={(v) => setEditor({ ...editor, kind: v as LibraryArticle["kind"] })}>
                  <SelectTrigger id="kbl-kind" className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mediflow_guide">How Mediflow works</SelectItem>
                    <SelectItem value="medicare_reference">General Medicare notes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={editor.defaultEnabled} onCheckedChange={(v) => setEditor({ ...editor, defaultEnabled: v })} />
                On by default for agencies that haven't chosen
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={editor.needsReview} onCheckedChange={(v) => setEditor({ ...editor, needsReview: v })} />
                Mark "Check before using" (figures or rules may be out of date)
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>Cancel</Button>
            <Button onClick={() => void saveArticle()} disabled={saving}>{saving ? "Saving…" : editor?.id ? "Save for every agency" : "Add to the library"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleteTarget?.title}” for every agency?</AlertDialogTitle>
            <AlertDialogDescription>It disappears for all agencies, along with each agency's on/off choice for it, and the assistant stops using it. To just hide it by default, edit it and turn off “On by default” instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
