/**
 * Small building blocks shared by the Client Portal, Softphone, Supervisor
 * and Quoting pages.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Loader2, Lock, Search, Sparkles, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/shared";
import { useContactSearch, useSoftphoneContactSearch, formatPhone, type ContactLite } from "@/lib/portalDialer/api";

/**
 * Friendly "this part isn't built yet" note. Says plainly what will happen,
 * so a finished-looking page never pretends to do something it can't.
 */
export function ComingSoonNote({
  title,
  children,
  icon: Icon = Sparkles,
  tone = "info",
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  tone?: "info" | "setup";
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "info"
          ? "border-accent/25 bg-accent/5 text-foreground"
          : "border-warning/30 bg-warning/10 text-foreground",
        className,
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          tone === "info" ? "bg-accent/10 text-accent" : "bg-warning/15 text-amber-700 dark:text-warning",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-0.5 text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** Small "Coming soon" label for buttons / headers. */
export function SoonBadge({ children = "Coming soon" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent whitespace-nowrap">
      {children}
    </span>
  );
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="rounded-xl border border-border bg-card p-10 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Lock className="h-6 w-6" />
        </div>
        <p className="font-display font-semibold">You don't have access to {what}.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask your agency administrator if you need it.
        </p>
      </div>
    </div>
  );
}

/**
 * Type-ahead contact search (name, email or phone) over `GET /contacts`.
 * Calls `onSelect` with the picked contact. `source="softphone"` searches the
 * self-scoped softphone endpoint (dialer fields only) instead of `GET /contacts`.
 */
export function ContactPicker({
  onSelect,
  placeholder = "Search clients by name, phone or email…",
  className,
  autoFocus,
  source = "contacts",
}: {
  onSelect: (c: ContactLite) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  source?: "contacts" | "softphone";
}) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const general = useContactSearch(debounced, open && source === "contacts");
  const dialer = useSoftphoneContactSearch(debounced, open && source === "softphone");
  const { data, isFetching, isError } = source === "softphone" ? dialer : general;
  const results = data?.data ?? [];
  const showList = open && debounced.trim().length >= 2;

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        aria-label="Search clients"
        className="pl-9 pr-8"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setText("");
            setOpen(false);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {showList && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          {isFetching && results.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : isError ? (
            <div className="px-3 py-3 text-sm text-destructive">Couldn't search clients. Try again.</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">No clients match "{debounced.trim()}".</div>
          ) : (
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      onSelect(c);
                      setText("");
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {c.firstName} {c.lastName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[formatPhone(c.phone), c.email].filter(Boolean).join(" · ") || "No phone or email"}
                      </span>
                    </span>
                    <StatusPill status={c.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
