// @vitest-environment jsdom
/**
 * Tests for `usePresenceHeartbeat` — the agent "available right now" pinger.
 *
 * The contract the inbound queue depends on: while available, the hook posts a
 * heartbeat on mount and re-posts on a fixed cadence inside the server TTL;
 * going away posts once and stops the cadence; a 404 (no linked agent) flips
 * `linked` off so the UI can hide the control. We stub `globalThis.fetch`
 * (which `apiRequest` calls) and drive the interval with fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  usePresenceHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from "@/hooks/usePresenceHeartbeat";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

/** Bodies of every heartbeat POST so far, oldest first. */
function sentStatuses(): string[] {
  return fetchMock.mock.calls.map(
    (c) => JSON.parse((c[1] as RequestInit).body as string).status,
  );
}

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      jsonResponse({ agentId: "a-1", status: "available", expiresAt: null }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("usePresenceHeartbeat — cadence", () => {
  it("posts available on mount and re-posts on the interval", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePresenceHeartbeat(true));

    // Mount fires one immediate heartbeat.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentStatuses()).toEqual(["available"]);
    expect((fetchMock.mock.calls[0][0] as string)).toContain(
      "/api/queue/presence/heartbeat",
    );
    expect(result.current.status).toBe("available");

    // One interval later → a second ping.
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {}); // flush pending state updates
  });

  it("going away posts once and stops the cadence", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePresenceHeartbeat(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => result.current.setStatus("away"));
    expect(result.current.status).toBe("away");
    expect(sentStatuses()).toEqual(["available", "away"]);

    // No further pings once away — the interval was torn down.
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Coming back resumes the cadence.
    act(() => result.current.setStatus("available"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {});
  });
});

describe("usePresenceHeartbeat — no linked agent", () => {
  it("flips linked off on a 404 and stops pinging", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "no agent" }, 404));
    const { result } = renderHook(() => usePresenceHeartbeat(true));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.linked).toBe(false);
    const callsAfter404 = fetchMock.mock.calls.length;

    // Linked=false short-circuits the ping loop; give it time to (not) fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfter404);
  });
});
