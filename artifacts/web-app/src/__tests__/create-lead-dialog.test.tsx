// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CreateLeadDialog from "@/pages/crm/CreateLeadDialog";

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateLeadDialog
        contactId="contact-123"
        contactName="Ada Agent"
        open
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 201,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ id: "lead-1", contactId: "contact-123" }),
  })) as unknown as Response);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("create lead from contact", () => {
  it("submits a lead for the contact shown in the dialog", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByText("Create lead for Ada Agent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create lead/i }));

    await waitFor(() => {
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url, init]) => String(url).includes("/api/leads") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({
        contactId: "contact-123",
        status: "new",
      });
    });
  });
});
