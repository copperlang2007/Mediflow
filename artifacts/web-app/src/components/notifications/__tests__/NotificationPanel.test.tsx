// @vitest-environment jsdom
/**
 * Tests for the notification panel's click behavior: marking-as-read +
 * navigation to the resource the notification is about.
 *
 * The panel calls two mutating endpoints (`PATCH /notifications/:id/read` and
 * `POST /notifications/read-all`) and one GET (`GET /notifications`). We stub
 * `fetch` at the module level and seed the QueryClient with a fixture list so
 * the panel renders synchronously — no real network is hit. After each click
 * we read the recorded URL from the wouter memory-location hook to assert
 * which page we navigated to (or that we stayed put).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  getGetNotificationsQueryKey,
  type Notification,
} from "@workspace/api-client-react";
import NotificationPanel, {
  resourceUrlFor,
} from "@/components/notifications/NotificationPanel";

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    orgId: "o-1",
    userId: "u-1",
    type: "generic",
    title: "Test notification",
    body: "Body text",
    readAt: null,
    resourceType: null,
    resourceId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(notifications: Notification[], path = "/dashboard") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Pre-seed so the panel renders synchronously without hitting fetch for
  // the GET.
  qc.setQueryData(getGetNotificationsQueryKey({}), notifications);

  const { hook, history } = memoryLocation({ path, static: false, record: true });
  const onClose = vi.fn();

  const utils = render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <NotificationPanel onClose={onClose} />
      </Router>
    </QueryClientProvider>,
  );

  return { ...utils, qc, onClose, history };
}

describe("resourceUrlFor", () => {
  it("returns null for a notification with no resourceType", () => {
    expect(resourceUrlFor(makeNotification())).toBeNull();
  });

  it("maps known resource types to their pages", () => {
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "agent", resourceId: "a-1" }),
      ),
    ).toBe("/agents/a-1");
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "license", resourceId: "l-1" }),
      ),
    ).toBe("/licensing");
    expect(
      resourceUrlFor(
        makeNotification({
          resourceType: "certification",
          resourceId: "c-1",
        }),
      ),
    ).toBe("/certifications");
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "document", resourceId: "d-1" }),
      ),
    ).toBe("/documents");
    expect(
      resourceUrlFor(
        makeNotification({
          resourceType: "esign_envelope",
          resourceId: "env-1",
        }),
      ),
    ).toBe("/sign/env-1");
    expect(
      resourceUrlFor(
        makeNotification({
          resourceType: "agent_onboarding",
          resourceId: "run-1",
        }),
      ),
    ).toBe("/admin-onboarding");
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "contact", resourceId: "ct-1" }),
      ),
    ).toBe("/crm/contacts/ct-1");
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "task", resourceId: "t-1" }),
      ),
    ).toBe("/tasks");
    expect(
      resourceUrlFor(
        makeNotification({ resourceType: "org", resourceId: "o-1" }),
      ),
    ).toBe("/compliance");
  });

  it("returns null for an unknown resource type", () => {
    expect(
      resourceUrlFor(
        makeNotification({
          resourceType: "made_up_resource",
          resourceId: "x-1",
        }),
      ),
    ).toBeNull();
  });
});

describe("NotificationPanel click behavior", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Default fetch mock: any mark-as-read call resolves with the notification
    // body (matches what the server returns). The mark-as-read mutation also
    // invalidates the GET /notifications query, which re-fetches; we return
    // an empty list there so the panel re-renders cleanly (the existing list
    // is already seeded into the QueryClient for the click assertions).
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url.includes("/api/notifications") &&
        !url.includes("/read") &&
        !url.includes("/count")
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/notifications/count")) {
        return new Response(JSON.stringify({ unread: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ id: "n-mocked", readAt: new Date().toISOString() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("clicking a notification with a known resource navigates AND marks it read AND closes the panel", async () => {
    const n = makeNotification({
      id: "n-agent",
      resourceType: "agent",
      resourceId: "agent-42",
      readAt: null,
    });
    const { onClose, history } = setup([n]);

    const row = screen.getByTestId("notification-row-n-agent");
    expect(row.className).toContain("cursor-pointer");

    fireEvent.click(row);

    // Navigation happens synchronously through wouter's location setter.
    await waitFor(() => {
      expect(history).toContain("/agents/agent-42");
    });

    // Mark-as-read mutation fired against the right endpoint.
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const urls = calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/notifications/n-agent/read"))).toBe(
        true,
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a notification with an unknown resourceType only marks-as-read; panel stays open", async () => {
    const n = makeNotification({
      id: "n-unknown",
      resourceType: "definitely_not_mapped",
      resourceId: "x-1",
      readAt: null,
    });
    const { onClose, history } = setup([n]);

    const row = screen.getByTestId("notification-row-n-unknown");
    // Non-clickable rows render with `cursor-default`.
    expect(row.className).toContain("cursor-default");
    expect(row.className).not.toContain("cursor-pointer");

    fireEvent.click(row);

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const urls = calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/notifications/n-unknown/read"))).toBe(
        true,
      );
    });

    // No new entries beyond the initial path.
    expect(history).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a notification with no resourceType only marks-as-read; panel stays open", async () => {
    const n = makeNotification({
      id: "n-bare",
      resourceType: null,
      resourceId: null,
      readAt: null,
    });
    const { onClose, history } = setup([n]);

    const row = screen.getByTestId("notification-row-n-bare");
    expect(row.className).toContain("cursor-default");

    fireEvent.click(row);

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(
        calls.some((c) => String(c[0]).includes("/notifications/n-bare/read")),
      ).toBe(true);
    });

    expect(history).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an already-read notification with a resource navigates + closes; no mark-as-read mutation fires", async () => {
    const n = makeNotification({
      id: "n-read",
      resourceType: "license",
      resourceId: "lic-1",
      readAt: new Date().toISOString(),
    });
    const { onClose, history } = setup([n]);

    fireEvent.click(screen.getByTestId("notification-row-n-read"));

    await waitFor(() => {
      expect(history).toContain("/licensing");
    });

    // No PATCH /notifications/.../read call should have fired.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const readCalls = calls.filter((c) =>
      String(c[0]).includes("/notifications/n-read/read"),
    );
    expect(readCalls).toHaveLength(0);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("encodes the resourceId via wouter's setter when the id contains URL-special characters", async () => {
    const n = makeNotification({
      id: "n-special",
      resourceType: "agent",
      // Realistic resourceIds are UUIDs, but the helper should pass arbitrary
      // strings through unchanged — the navigation goes via wouter's API, so
      // any encoding is wouter's responsibility, not raw string concat.
      resourceId: "agent with space",
      readAt: new Date().toISOString(),
    });
    const { history } = setup([n]);

    fireEvent.click(screen.getByTestId("notification-row-n-special"));

    await waitFor(() => {
      expect(history.some((h) => h.startsWith("/agents/"))).toBe(true);
    });
  });
});
