/**
 * Knowledge Base (agencyBRIDGE KnowledgeBasePage) on the real `kb_articles`
 * table: `/api/kb/articles` CRUD. Everyone in the agency can read; agency
 * owners add, edit, switch off and delete. Active articles are also handed to
 * the AI assistant as reference material when a question matches them.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  BookOpen,
  EyeOff,
  FolderTree,
  Hash,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { openAiAssistant } from "@/components/ai-assistant";
import { cn } from "@/lib/utils";
import { KnowledgeLibrary } from "./knowledge-library";

export type KbArticle = {
  id: string;
  category: string;
  title: string;
  content: string;
  keywords: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type KbResponse = {
  articles: KbArticle[];
  stats: { total: number; active: number; categories: number; keywords: number };
};

const EDITOR_ROLES = ["super_admin", "agency_admin"];
const AI_ROLES = ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"];
const ALL = "all";

type EditorState = { id?: string; category: string; title: string; content: string; keywords: string; isActive: boolean };
const EMPTY: EditorState = { category: "", title: "", content: "", keywords: "", isActive: true };

/** Switches between the agency's own articles and the shared Mediflow library. */
export default function KnowledgeBasePage() {
  const [view, setView] = useState<"own" | "library">("own");
  const viewSwitch = (
    <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Which articles">
      <Button size="sm" variant={view === "own" ? "default" : "ghost"} onClick={() => setView("own")}>Our articles</Button>
      <Button size="sm" variant={view === "library" ? "default" : "ghost"} onClick={() => setView("library")}>Mediflow library</Button>
    </div>
  );
  return view === "own" ? <OwnArticles viewSwitch={viewSwitch} /> : <KnowledgeLibrary viewSwitch={viewSwitch} />;
}

function OwnArticles({ viewSwitch }: { viewSwitch: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const canEdit = EDITOR_ROLES.includes(me?.role ?? "");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KbArticle | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (category !== ALL) params.set("category", category);
  if (canEdit) params.set("includeInactive", "true");
  const qs = params.toString();

  const listKey = ["/api/kb/articles", qs];
  const { data, isLoading, isError } = useQuery({
    queryKey: listKey,
    queryFn: () => customFetch<KbResponse>(`/api/kb/articles${qs ? `?${qs}` : ""}`),
  });
  // Unfiltered list for the category dropdown.
  const { data: allData } = useQuery({
    queryKey: ["/api/kb/articles", "categories", canEdit],
    queryFn: () => customFetch<KbResponse>(`/api/kb/articles${canEdit ? "?includeInactive=true" : ""}`),
  });

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of allData?.articles ?? []) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allData]);

  const stats = data?.stats;
  const articles = data?.articles ?? [];

  const refresh = () => void qc.invalidateQueries({ queryKey: ["/api/kb/articles"] });

  const save = async () => {
    if (!editor) return;
    if (!editor.title.trim() || !editor.content.trim() || !editor.category.trim()) {
      toast({ title: "Almost there", description: "Category, title and the article text are all needed.", variant: "destructive" });
      return;
    }
    setSaving(true);
    const body = JSON.stringify({
      category: editor.category.trim(),
      title: editor.title.trim(),
      content: editor.content.trim(),
      keywords: editor.keywords.split(",").map((k) => k.trim()).filter(Boolean),
      isActive: editor.isActive,
    });
    try {
      if (editor.id) {
        await customFetch(`/api/kb/articles/${editor.id}`, { method: "PATCH", body });
        toast({ title: "Article updated" });
      } else {
        await customFetch("/api/kb/articles", { method: "POST", body });
        toast({ title: "Article added", description: "The AI assistant can use it straight away." });
      }
      setEditor(null);
      refresh();
    } catch {
      toast({ title: "Couldn't save the article", description: "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (a: KbArticle) => {
    try {
      await customFetch(`/api/kb/articles/${a.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !a.isActive }) });
      refresh();
    } catch {
      toast({ title: "Couldn't change the article", variant: "destructive" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await customFetch(`/api/kb/articles/${deleteTarget.id}`, { method: "DELETE" });
      toast({ title: "Article removed" });
      refresh();
    } catch {
      toast({ title: "Couldn't remove the article", variant: "destructive" });
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Knowledge Base"
        subtitle="Your agency's answers in one place — plan rules, carrier quirks and how-tos. The AI assistant reads these too."
      >
        {viewSwitch}
        {/* The assistant needs contact access (server: /ai/chat is contact:read). */}
        {me && AI_ROLES.includes(me.role) && (
          <Button variant="outline" size="sm" onClick={() => openAiAssistant()}>
            <Sparkles className="mr-1.5 h-4 w-4" /> Ask the assistant
          </Button>
        )}
        {canEdit && (
          <Button size="sm" onClick={() => setEditor({ ...EMPTY, category: categories[0]?.[0] ?? "" })}>
            <Plus className="mr-1.5 h-4 w-4" /> Add article
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniStat label="Articles" value={stats?.total ?? 0} icon={BookOpen} loading={isLoading} />
        <MiniStat label="Categories" value={stats?.categories ?? 0} icon={FolderTree} loading={isLoading} />
        <MiniStat label="Switched on" value={stats?.active ?? 0} icon={Sparkles} loading={isLoading} tone="success" />
        <MiniStat label="Keywords indexed" value={stats?.keywords ?? 0} icon={Hash} loading={isLoading} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search titles, text and keywords…" className="pl-9" aria-label="Search articles" />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[220px]" aria-label="Category"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {categories.map(([c, n]) => <SelectItem key={c} value={c}>{c} ({n})</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>
      ) : isError ? (
        <div className="rounded-xl border border-border bg-card"><EmptyState icon={BookOpen} title="Couldn't load the Knowledge Base" description="Please refresh the page." /></div>
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-border bg-card">
          {search || category !== ALL ? (
            <EmptyState icon={Search} title="No articles match" description="Try a different word or category." />
          ) : (
            <EmptyState
              icon={BookOpen}
              title="No articles yet"
              description={canEdit
                ? "Write down the answers your team asks for most — enrollment windows, carrier rules, how your agency does things."
                : "Your agency hasn't added any articles yet."}
              action={canEdit ? { label: "Add the first article", onClick: () => setEditor({ ...EMPTY }) } : undefined}
            />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {articles.map((a) => (
            <article key={a.id} className={cn("rounded-xl border border-border bg-card p-4 shadow-sm", !a.isActive && "opacity-60")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                      <Tag className="h-3 w-3" /> {a.category}
                    </span>
                    {!a.isActive && <StatusPill tone="neutral"><EyeOff className="mr-1 h-3 w-3" /> Switched off</StatusPill>}
                  </div>
                  <h3 className="font-display text-base font-semibold">{a.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-3 whitespace-pre-line">{a.content}</p>
                  {a.keywords.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.keywords.slice(0, 8).map((k) => (
                        <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{k}</span>
                      ))}
                      {a.keywords.length > 8 && <span className="text-[11px] text-muted-foreground">+{a.keywords.length - 8} more</span>}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-muted-foreground">Updated {formatDistanceToNow(new Date(a.updatedAt), { addSuffix: true })}</p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch checked={a.isActive} onCheckedChange={() => void toggleActive(a)} aria-label={a.isActive ? "Switch off" : "Switch on"} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit"
                      onClick={() => setEditor({ id: a.id, category: a.category, title: a.title, content: a.content, keywords: a.keywords.join(", "), isActive: a.isActive })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label="Delete" onClick={() => setDeleteTarget(a)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={editor !== null} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">{editor?.id ? "Edit article" : "Add article"}</DialogTitle>
            <DialogDescription>Write it the way you'd explain it to a new agent.</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
                <span>Never put client information here (names, Medicare IDs, health details). Articles are shared with everyone in your agency and with the AI assistant.</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="kb-category">Category</Label>
                  <Input id="kb-category" list="kb-categories" value={editor.category} onChange={(e) => setEditor({ ...editor, category: e.target.value })} placeholder="e.g. Enrollment periods" className="mt-1" />
                  <datalist id="kb-categories">{categories.map(([c]) => <option key={c} value={c} />)}</datalist>
                </div>
                <div>
                  <Label htmlFor="kb-title">Title</Label>
                  <Input id="kb-title" value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="e.g. When can clients switch plans?" className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="kb-content">Article</Label>
                <Textarea id="kb-content" rows={10} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="kb-keywords">Keywords</Label>
                <Input id="kb-keywords" value={editor.keywords} onChange={(e) => setEditor({ ...editor, keywords: e.target.value })} placeholder="aep, switching, oep (separate with commas)" className="mt-1" />
                <p className="mt-1 text-xs text-muted-foreground">The assistant uses these words to find this article when someone asks a question.</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={editor.isActive} onCheckedChange={(v) => setEditor({ ...editor, isActive: v })} />
                Switched on (visible to your team and the assistant)
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : editor?.id ? "Save changes" : "Add article"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>It disappears for everyone and the assistant stops using it. To hide it for now instead, switch it off.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
