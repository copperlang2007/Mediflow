// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { customFetch } = vi.hoisted(() => ({ customFetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));

import { GhlConnectionCard } from "@/components/integrations/GhlConnectionCard";

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GhlConnectionCard />
    </QueryClientProvider>,
  );
}

describe("GhlConnectionCard", () => {
  beforeEach(() => {
    customFetch.mockReset();
  });

  it("says when GoHighLevel isn't connected and doesn't ask for fields", async () => {
    customFetch.mockImplementation(async () => ({ configured: false, locationId: null, lastRunAt: null, lastStatus: null, lastError: null, lastRun: null }));
    renderCard();
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(customFetch).not.toHaveBeenCalledWith("/api/integrations/ghl/custom-fields");
  });

  it("lists the account's custom fields when connected", async () => {
    customFetch.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? { configured: true, locationId: "loc-1", lastRunAt: null, lastStatus: "ok", lastError: null, lastRun: null }
        : { locationId: "loc-1", fields: [{ id: "cf-1", name: "Medicare Number", fieldKey: "contact.medicare_number", dataType: "TEXT" }] },
    );
    renderCard();
    expect(await screen.findByText("Medicare Number")).toBeInTheDocument();
    expect(screen.getByText("contact.medicare_number")).toBeInTheDocument();
    expect(screen.getByText("Custom fields (1)")).toBeInTheDocument();
  });

  it("shows GoHighLevel's error when the token lacks the scope", async () => {
    customFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { configured: true, locationId: "loc-1", lastRunAt: null, lastStatus: "ok", lastError: null, lastRun: null };
      throw Object.assign(new Error("HTTP 502"), { data: { error: "GHL custom fields failed: HTTP 403 — check the Private Integration token" } });
    });
    renderCard();
    expect(await screen.findByText(/custom fields failed: HTTP 403/)).toBeInTheDocument();
  });

  it("queues a full re-read only after confirmation", async () => {
    customFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith("/status")) return { configured: true, locationId: "loc-1", lastRunAt: null, lastStatus: "ok", lastError: null, lastRun: null };
      if (url.endsWith("/sync")) return { queued: true, full: JSON.parse(init!.body!).full, alreadyRunning: false };
      return { locationId: "loc-1", fields: [] };
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Re-read all contacts" }));
    expect(customFetch).not.toHaveBeenCalledWith("/api/integrations/ghl/sync", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Yes, re-read all" }));
    expect(await screen.findByText(/Full re-read queued/)).toBeInTheDocument();
    expect(customFetch).toHaveBeenCalledWith("/api/integrations/ghl/sync", expect.objectContaining({ method: "POST", body: JSON.stringify({ full: true }) }));
  });

  it("queues an incremental sync", async () => {
    customFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { configured: true, locationId: "loc-1", lastRunAt: null, lastStatus: "ok", lastError: null, lastRun: null };
      if (url.endsWith("/sync")) return { queued: true, full: false, alreadyRunning: false };
      return { locationId: "loc-1", fields: [] };
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/Sync queued/)).toBeInTheDocument();
  });

  it("shows skipped contacts and backfill progress", async () => {
    customFetch.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? {
            configured: true, locationId: "loc-1", running: true, lastStatus: "more_pending", lastError: null,
            lastRunAt: new Date().toISOString(), cursorUpdatedAt: "2025-06-01T00:00:00.000Z", backfillCompletedAt: null,
            lastRun: { created: 40, updated: 10, skipped: 52, failed: 2 },
          }
        : { locationId: "loc-1", fields: [] },
    );
    renderCard();
    expect(await screen.findByText(/40 added · 10 updated · 50 skipped · 2 failed/)).toBeInTheDocument();
    expect(screen.getByText(/First full import running: caught up to contacts last changed/)).toBeInTheDocument();
    expect(screen.getByText(/no first and last name/)).toBeInTheDocument();
  });
});
