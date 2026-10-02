// @vitest-environment jsdom
/**
 * Uploading a commission statement: the file is read during the upload itself.
 * The server does not keep uploaded files, so a second request without the
 * file (the old behaviour) could never work.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: { method?: string; body?: unknown } }>,
  response: { id: "s1", status: "parsed", parse: { inserted: 3 } } as Record<string, unknown>,
  toasts: [] as string[],
  list: [] as unknown[],
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    h.calls.push({ url: String(url), init });
    const path = String(url).split("?")[0]!;
    if (!init?.method && path === "/api/commissions/statements") return h.list;
    if (!init?.method) return [];
    return h.response;
  }),
  useGetCarriers: () => ({ data: [{ id: "c1", name: "Humana" }] }),
}));

vi.mock("@/lib/branding/BrandingProvider", () => ({ useProductName: () => "Mediflow" }));

vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => h.toasts.push(`success: ${m}`),
    error: (m: string) => h.toasts.push(`error: ${m}`),
    message: (m: string) => h.toasts.push(`message: ${m}`),
  },
}));

// A native <select> stands in for the Radix one (which needs pointer events).
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="carrier" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">-</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

afterEach(() => {
  h.list = [];
  h.calls.length = 0;
  h.toasts.length = 0;
  h.response = { id: "s1", status: "parsed", parse: { inserted: 3 } };
});

async function submitUpload() {
  const { UploadStatementDialog } = await import("@/pages/commissions");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UploadStatementDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByTestId("carrier"), { target: { value: "c1" } });
  const dates = document.querySelectorAll('input[type="date"]');
  fireEvent.change(dates[0]!, { target: { value: "2026-01-01" } });
  fireEvent.change(dates[1]!, { target: { value: "2026-01-31" } });
  fireEvent.change(document.querySelector('input[type="number"]')!, { target: { value: "37.50" } });
  const file = new File(["a|b"], "humana.csv", { type: "text/csv" });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
  // Submit the form directly: jsdom's built-in `required` check can't see a file
  // we attached programmatically.
  expect(screen.getByRole("button", { name: /upload & parse/i })).toBeEnabled();
  fireEvent.submit(document.querySelector("form")!);
}

describe("Upload commission statement", () => {
  it("only offers file types the readers can handle", async () => {
    const { UploadStatementDialog } = await import("@/pages/commissions");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UploadStatementDialog open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    const input = (await screen.findByText(/Text files only/i)).parentElement!.querySelector('input[type="file"]')!;
    expect(input.getAttribute("accept")).toContain(".csv");
    expect(input.getAttribute("accept")).not.toContain(".pdf");
    expect(input.getAttribute("accept")).not.toContain(".xls");
  });

  it("sends the file once and asks the server to read it in the same request", async () => {
    await submitUpload();
    await waitFor(() => expect(h.toasts.some((t) => t.startsWith("success"))).toBe(true));

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("/api/commissions/statements");
    expect(h.calls.some((c) => c.url.endsWith("/parse"))).toBe(false);
    const body = h.calls[0]!.init!.body as FormData;
    expect(body.get("parse")).toBe("true");
    expect((body.get("file") as File).name).toBe("humana.csv");
    expect(h.toasts.join()).toContain("3 lines read");
  });

  it("says why when the file could not be read, instead of claiming success", async () => {
    h.response = { id: "s1", status: "pending", parse: { error: "No reader for this carrier." } };
    await submitUpload();
    await waitFor(() => expect(h.toasts.length).toBeGreaterThan(0));
    expect(h.toasts.join()).toContain("couldn't be read");
    expect(h.toasts.join()).toContain("No reader for this carrier.");
    expect(h.toasts.some((t) => t.startsWith("success"))).toBe(false);
  });
});

describe("Pending statement: Parse (choose file)", () => {
  it("asks for the file and sends it to that statement's parse endpoint", async () => {
    h.list = [{
      id: "stmt-77", orgId: "o", carrierId: "c1", carrierName: "Humana", periodStart: "2026-01-01",
      periodEnd: "2026-01-31", totalAmount: "37.50", status: "pending", uploadedAt: "2026-02-01T00:00:00Z",
    }];
    h.response = { inserted: 3 };
    const { default: CommissionsPage } = await import("@/pages/commissions");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CommissionsPage />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: /parse \(choose file\)/i });
    fireEvent.click(button);
    const picker = screen.getByLabelText("Choose the statement file to read") as HTMLInputElement;
    expect(picker.getAttribute("accept")).not.toContain(".pdf");
    const file = new File(["a|b"], "humana.csv", { type: "text/csv" });
    fireEvent.change(picker, { target: { files: [file] } });

    await waitFor(() => expect(h.calls.some((c) => c.url === "/api/commissions/statements/stmt-77/parse")).toBe(true));
    const call = h.calls.find((c) => c.url.endsWith("/parse"))!;
    expect(call.init!.method).toBe("POST");
    expect((call.init!.body as FormData).get("file")).toBe(file);
    await waitFor(() => expect(h.toasts.join()).toContain("3 lines"));
  });
});
