// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const errorSpy = vi.fn();
const history: Array<{ type: string }> = [];
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => {
      errorSpy(...args);
      history.push({ type: "error" });
    },
    getHistory: () => history,
  },
}));

import { notifyQueryError, queryClient } from "@/lib/queryClient";

class HttpError extends Error {
  constructor(public status: number, message = `HTTP ${status}`) {
    super(message);
  }
}

beforeEach(() => {
  errorSpy.mockClear();
  history.length = 0;
});

describe("query error toasts", () => {
  it("does not toast 404s (pages show their own not-found state)", () => {
    notifyQueryError(new HttpError(404));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses plain language and one fixed id per kind for 403 and 5xx", () => {
    notifyQueryError(new HttpError(403, "HTTP 403 Forbidden: Forbidden"));
    notifyQueryError(new HttpError(500));
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "You don't have access to some of the information on this page.",
      expect.objectContaining({ id: "query-error-403" }),
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      "Something went wrong loading this page.",
      expect.objectContaining({ id: "query-error-5xx" }),
    );
  });
});

describe("mutation error toasts", () => {
  function failMutation(err: Error, meta?: { toastOnError?: boolean }) {
    const cache = queryClient.getMutationCache();
    const mutation = cache.build(queryClient, { mutationFn: async () => { throw err; }, meta });
    return mutation.execute(undefined).catch(() => undefined);
  }

  it("stays quiet unless the mutation opts in with toastOnError", async () => {
    vi.useFakeTimers();
    await failMutation(new HttpError(500));
    // the page's catch block
    history.push({ type: "error" });
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses the shared plain-language message for a mutation that opts in", async () => {
    vi.useFakeTimers();
    await failMutation(new HttpError(403), { toastOnError: true });
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
    expect(errorSpy).toHaveBeenCalledWith(
      "You don't have permission to do that.",
      expect.objectContaining({ id: "mutation-error-403" }),
    );
  });
});
