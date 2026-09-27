/**
 * Tests for the global QueryCache / MutationCache error toasts.
 *
 * Pins the policy: query failures toast unless the query opts out with
 * `meta: { silent: true }`; mutation failures toast only with
 * `meta: { toastOnError: true }` (call sites report their own); and a query that keeps failing reuses one toast
 * id instead of stacking a new toast every refetch. With several components
 * watching one query, it is silent only if all of them opted out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { QueryObserver } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

function failingQuery(key: string, meta?: { silent?: boolean }) {
  return queryClient
    .fetchQuery({
      queryKey: [key],
      queryFn: () => Promise.reject(new Error(`${key} failed`)),
      retry: false,
      meta,
    })
    .catch(() => undefined);
}

function failingMutation(meta?: { toastOnError?: boolean }) {
  return queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationFn: () => Promise.reject(new Error("save failed")),
      meta,
    })
    .execute(undefined)
    .catch(() => undefined);
}

describe("global query/mutation error toasts", () => {
  beforeEach(() => {
    toastError.mockClear();
    queryClient.clear();
  });

  it("toasts a failed query with a per-query id", async () => {
    await failingQuery("loud");
    expect(toastError).toHaveBeenCalledTimes(1);
    const [message, opts] = toastError.mock.calls[0];
    expect(message).toBe("loud failed");
    const hash = queryClient.getQueryCache().find({ queryKey: ["loud"] })?.queryHash;
    expect(opts.id).toBe(`query:${hash}`);
  });

  it("reuses the same toast id when the same query fails again", async () => {
    await failingQuery("poll");
    await failingQuery("poll");
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError.mock.calls[0][1].id).toBe(toastError.mock.calls[1][1].id);
  });

  it("does not toast a query marked silent", async () => {
    await failingQuery("badge", { silent: true });
    expect(toastError).not.toHaveBeenCalled();
  });

  describe("shared query keys", () => {
    function observe(key: string, silent: boolean) {
      const observer = new QueryObserver(queryClient, {
        queryKey: [key],
        queryFn: () => Promise.reject(new Error(`${key} failed`)),
        retry: false,
        meta: silent ? { silent: true } : undefined,
      });
      return observer.subscribe(() => {});
    }

    it("still toasts when a silent observer shares the key with a loud one", async () => {
      const unsubs = [observe("shared", false), observe("shared", true)];
      await queryClient.refetchQueries({ queryKey: ["shared"] }).catch(() => undefined);
      expect(toastError).toHaveBeenCalled();
      unsubs.forEach((u) => u());
    });

    it("still toasts when the loud observer unmounts mid-request", async () => {
      let reject!: (e: Error) => void;
      const queryFn = () => new Promise<never>((_, r) => (reject = r));
      const observer = (silent: boolean) =>
        new QueryObserver(queryClient, {
          queryKey: ["midflight"],
          queryFn,
          retry: false,
          meta: silent ? { silent: true } : undefined,
        }).subscribe(() => {});
      const unsubBadge = observer(true);
      const unsubPage = observer(false);
      const inFlight = queryClient.refetchQueries({ queryKey: ["midflight"] });
      unsubPage(); // user navigates away before the response arrives
      reject(new Error("midflight failed"));
      await inFlight.catch(() => undefined);
      expect(toastError).toHaveBeenCalledWith("midflight failed", expect.anything());
      unsubBadge();
    });

    it("stays silent when every observer is silent", async () => {
      const unsubs = [observe("ambient", true), observe("ambient", true)];
      await queryClient.refetchQueries({ queryKey: ["ambient"] }).catch(() => undefined);
      expect(toastError).not.toHaveBeenCalled();
      unsubs.forEach((u) => u());
    });
  });

  it("only toasts a failed mutation that opts in with toastOnError", async () => {
    // Call sites report their own mutation errors, so the global toast is
    // opt-in to avoid a duplicate raw-error toast next to theirs.
    await failingMutation();
    expect(toastError).not.toHaveBeenCalled();

    await failingMutation({ toastOnError: true });
    expect(toastError).toHaveBeenCalledWith("save failed");
  });
});
