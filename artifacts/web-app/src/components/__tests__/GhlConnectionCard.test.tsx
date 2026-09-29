// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
});
