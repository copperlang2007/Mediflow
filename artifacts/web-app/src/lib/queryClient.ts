import { QueryClient, QueryCache, MutationCache, type Query } from "@tanstack/react-query";
import { toast } from "sonner";

// Typed `meta` for every query/mutation in the app.
//   Queries — silent: true: never toast this failure globally. Use for
//   ambient or optional queries (nav badges, breadcrumb lookups, background
//   polls) whose failure the user didn't ask about and can't act on.
//   Mutations — toastOnError: true: opt in to the global error toast, for a
//   mutation that doesn't report its own failure.
declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: Record<string, unknown> & { silent?: boolean };
    mutationMeta: Record<string, unknown> & { toastOnError?: boolean };
  }
}

type AnyQuery = Query<unknown, unknown, unknown, readonly unknown[]>;

// `query.meta` belongs to the shared cache entry, so whichever component
// set options last would decide for everyone. Read each observer's own
// options instead: a query is silent only if every component watching it
// asked for silence, so an ambient silent poll can't mute a page's errors.
const isLoudObserver = (o: AnyQuery["observers"][number]) => o.options.meta?.silent !== true;

// Queries whose in-flight fetch had a non-silent watcher at some point
// (maintained by the cache subscription below). Checked first so a page
// that navigates away mid-request still gets its failure toasted, even if
// only a silent observer (e.g. the nav badge) remains when it settles.
const loudFetches = new WeakSet<AnyQuery>();

function isSilent(query: AnyQuery): boolean {
  if (loudFetches.has(query)) return false;
  if (query.observers.length === 0) return query.meta?.silent === true;
  return !query.observers.some(isLoudObserver);
}

function toMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return (error as { message: string }).message;
  }
  return "An unexpected error occurred";
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const s = (error as { status: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/**
 * Plain-language toast for a failed background load. Each kind of failure
 * uses a fixed toast id, so a page with several failing requests shows one
 * message instead of a stack of "HTTP 403" notices.
 *
 * 404s are not toasted: pages already render their own "not found" /
 * "not created yet" states for those (e.g. an offboarding report that has
 * not been generated). A query can opt out entirely with `meta: { silent: true }`.
 */
export function notifyQueryError(error: unknown): void {
  const status = statusOf(error);
  if (status === 404) return;
  if (status === 401) {
    toast.error("Your session has ended. Please sign in again.", { id: "query-error-401" });
  } else if (status === 403) {
    toast.error("You don't have access to some of the information on this page.", {
      id: "query-error-403",
      description: "Ask an admin if you think you should.",
    });
  } else if (status !== undefined && status >= 500) {
    toast.error("Something went wrong loading this page.", {
      id: "query-error-5xx",
      description: "Please try again in a moment.",
    });
  } else {
    const message = toMessage(error);
    toast.error(message, { id: `query-error:${message}` });
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (isSilent(query)) return;
      // 401 / 403 / 5xx / 404 get the plain-language handling (one fixed id
      // per kind). Anything else: one toast per query, so a polling query
      // that keeps failing replaces its own toast instead of stacking.
      const status = statusOf(error);
      if (status === 404 || status === 401 || status === 403 || (status !== undefined && status >= 500)) {
        notifyQueryError(error);
        return;
      }
      toast.error(toMessage(error), { id: `query:${query.queryHash}` });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // Opt-in: nearly every mutation call site already reports its own
      // failure (a friendly toast in onError/catch, or inline form state),
      // so a global raw-error toast would double up on each of them.
      if (mutation.meta?.toastOnError !== true) return;
      const status = statusOf(error);
      if (status === 403) {
        toast.error("You don't have permission to do that.", { id: "mutation-error-403" });
      } else if (status === 401) {
        toast.error("Your session has ended. Please sign in again.", { id: "query-error-401" });
      } else if (status !== undefined && status >= 500) {
        toast.error("Something went wrong saving that. Please try again.", { id: "mutation-error-5xx" });
      } else {
        toast.error(toMessage(error));
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error: unknown) => {
        const status = statusOf(error);
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
  },
});

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "fetch") {
    // New fetch: loud iff someone non-silent is watching as it starts.
    if (event.query.observers.some(isLoudObserver)) loudFetches.add(event.query);
    else loudFetches.delete(event.query);
  } else if (
    event.type === "observerAdded" &&
    event.query.state.fetchStatus === "fetching" &&
    isLoudObserver(event.observer)
  ) {
    // A loud component joined a fetch that was already in flight.
    loudFetches.add(event.query);
  }
});
