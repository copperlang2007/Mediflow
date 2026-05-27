/**
 * Tests for `apiFetch`'s optional AbortSignal pass-through.
 *
 * The helper has always taken a `RequestInit` second argument (which technically
 * includes `signal`), but the new `ApiFetchOptions` interface spells out the
 * cancellation contract explicitly. These tests pin the wire-level behaviour so
 * call sites can rely on the standard fetch abort semantics.
 *
 * Note: this file uses the default `node` environment — `globalThis.fetch` and
 * `AbortController` are both available natively in Node 18+.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch } from "@/lib/api";

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("apiFetch — AbortSignal pass-through", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("forwards a provided AbortSignal to the underlying fetch call", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const controller = new AbortController();

    await apiFetch("/api/x", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(controller.signal);
    // Sanity: existing options still get through.
    expect((init as RequestInit).credentials).toBe("include");
  });

  it("rejects with an AbortError when called with an already-aborted signal", async () => {
    // When the signal is pre-aborted, `fetch` itself rejects synchronously
    // with an AbortError — we just verify apiFetch surfaces that contract
    // without swallowing it.
    fetchMock.mockImplementation((_url: string, init: RequestInit = {}) => {
      if (init.signal?.aborted) {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      apiFetch("/api/x", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the signal aborts mid-request", async () => {
    // Simulate a fetch that resolves only when its signal aborts. This is the
    // standard browser behaviour we want apiFetch to inherit.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The user aborted a request.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const controller = new AbortController();
    const promise = apiFetch("/api/x", { signal: controller.signal });
    // Trigger abort on the next tick so the fetch has a chance to register
    // its listener.
    setTimeout(() => controller.abort(), 0);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("leaves behaviour unchanged when no signal is passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const result = await apiFetch<{ ok: boolean }>("/api/x");

    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0]!;
    // No signal key written to the init bag — keeps the legacy call shape.
    expect((init as RequestInit).signal).toBeUndefined();
    expect((init as RequestInit).credentials).toBe("include");
  });
});
