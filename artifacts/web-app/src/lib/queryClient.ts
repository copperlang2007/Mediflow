import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { toast } from "sonner";

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
      if (query.meta?.silent) return;
      notifyQueryError(error);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return;
      // Most pages catch their own save errors and say what failed ("Failed
      // to create contact"). Their catch runs right after this hook, so wait
      // a moment and only show the shared message when the page didn't.
      const seen = toast.getHistory().length;
      setTimeout(() => {
        const pageToasted = toast
          .getHistory()
          .slice(seen)
          .some((t) => "type" in t && t.type === "error");
        if (pageToasted) return;
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
      }, 50);
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
