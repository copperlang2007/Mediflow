// @vitest-environment jsdom
/**
 * Agent-role self access on the web side: the onboarding wizard resolves the
 * caller through GET /agents/me (not the roster) and shows a clear empty state
 * when no agent profile is linked; the Tasks page never offers template or
 * task-creation UI to agents (the API answers 403 for both).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";

function meBody(role: string) {
  return {
    id: "user-1",
    orgId: "org-1",
    email: "u@example.com",
    fullName: "User One",
    role,
    isActive: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

function makeQc(role: string): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(getGetMeQueryKey(), meBody(role));
  return qc;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let calls: string[] = [];
function mockFetch(role: string, handler: (url: string) => Response) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes("/users/me")) return json(200, meBody(role));
    return handler(url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

async function renderPage(node: React.ReactNode, qc: QueryClient, path: string) {
  const { hook } = memoryLocation({ path, static: false });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <TooltipProvider>{node}</TooltipProvider>
        </Router>
      </QueryClientProvider>,
    );
  });
}

describe("onboarding wizard — agent without a linked profile", () => {
  it("uses /agents/me (never the roster) and shows the not-linked empty state on 404", async () => {
    mockFetch("agent", (url) => {
      if (url.includes("/agents/me")) return json(404, { error: "Agent profile not linked" });
      return json(200, {});
    });
    const { default: OnboardingPage } = await import("@/pages/onboarding");
    await renderPage(<OnboardingPage />, makeQc("agent"), "/onboarding");
    await waitFor(() =>
      expect(
        screen.getByText("Your agent profile isn't linked to your account yet. Please contact your admin."),
      ).toBeInTheDocument(),
    );
    expect(calls.some((u) => u.includes("/agents/me"))).toBe(true);
    expect(calls.some((u) => /\/agents(\?|$)/.test(u))).toBe(false);
  });
});

describe("tasks page — agent role", () => {
  it("hides New Task and Templates and never fetches templates", async () => {
    mockFetch("agent", (url) => {
      if (url.includes("/task-templates")) return json(403, { error: "Forbidden" });
      if (url.includes("/tasks")) return json(200, { tasks: [], total: 0, limit: 100, offset: 0 });
      return json(200, {});
    });
    const { default: TasksPage } = await import("@/pages/tasks");
    await renderPage(<TasksPage />, makeQc("agent"), "/tasks");
    await waitFor(() => expect(calls.some((u) => u.includes("/tasks"))).toBe(true));
    expect(screen.queryByRole("button", { name: /new task/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /templates/i })).toBeNull();
    expect(calls.some((u) => u.includes("/task-templates"))).toBe(false);
  });

  it("still offers New Task, Templates and the templates fetch to admins", async () => {
    mockFetch("agency_admin", (url) => {
      if (url.includes("/task-templates")) return json(200, []);
      if (url.includes("/tasks")) return json(200, { tasks: [], total: 0, limit: 100, offset: 0 });
      return json(200, {});
    });
    const { default: TasksPage } = await import("@/pages/tasks");
    await renderPage(<TasksPage />, makeQc("agency_admin"), "/tasks");
    expect(await screen.findByRole("button", { name: /new task/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /templates/i })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((u) => u.includes("/task-templates"))).toBe(true));
  });
});
