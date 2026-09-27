import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Search, User, ArrowRight } from "lucide-react";
import { useGetContacts, getGetContactsQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Top-bar search. Types-ahead against the existing contacts search endpoint
 * (GET /api/contacts?search=… — name, email, phone, or exact Medicare ID)
 * and shows up to six matches. Enter (or "See all results") opens Clients &
 * Leads filtered to the query via `/crm?q=…`.
 *
 * Only rendered for roles that can read contacts; the server enforces the
 * same rule, so this is purely about not showing a box that would 403.
 */
export function GlobalSearch({ className }: { className?: string }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const enabled = debounced.length >= 2;
  const params = { search: debounced, limit: 6 };
  const { data, isFetching } = useGetContacts(params, {
    query: { queryKey: getGetContactsQueryKey(params), enabled, staleTime: 15_000 },
  });
  const results = enabled ? (data?.data ?? []) : [];

  const goToAll = () => {
    const q = query.trim();
    setOpen(false);
    navigate(q ? `/crm?q=${encodeURIComponent(q)}` : "/crm");
  };

  return (
    <div ref={wrapRef} className={cn("relative flex-1 max-w-md", className)}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          goToAll();
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search clients by name, phone or email…"
          aria-label="Search clients"
          className="h-10 pl-9 bg-muted/60 border-transparent focus-visible:bg-card focus-visible:ring-1 focus-visible:ring-accent"
        />
      </form>

      {open && enabled && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {isFetching ? "Searching…" : `No clients match “${debounced}”.`}
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setQuery("");
                      navigate(`/crm/contacts/${c.id}`);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
                      <User className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {c.firstName} {c.lastName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone on file"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={goToAll}
            className="flex w-full items-center justify-between border-t border-border px-4 py-2.5 text-sm font-medium text-accent hover:bg-muted"
          >
            See all results in Clients &amp; Leads
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
