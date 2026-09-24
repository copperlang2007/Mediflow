// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DataMigrationPage from "@/pages/data-migration";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { role: "agency_admin" } }),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DataMigrationPage />
    </QueryClientProvider>,
  );
}

describe("client CSV upload", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/validate")
        ? { totalRows: 1, validRows: 1, errorCount: 0, errors: [] }
        : {
            headers: ["First Name", "Last Name", "Email"],
            sampleRows: [{ "First Name": "Ada", "Last Name": "Lovelace", Email: "ada@example.com" }],
            totalRows: 1,
            suggestedMapping: {
              "First Name": "firstName",
              "Last Name": "lastName",
              Email: "email",
            },
            targetFields: [
              { field: "firstName", label: "First Name", required: true },
              { field: "lastName", label: "Last Name", required: true },
              { field: "email", label: "Email" },
            ],
          };
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens field mapping and lets an admin skip a CSV column", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(screen.getByRole("tab", { name: /generic csv/i }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["First Name,Last Name,Email\nAda,Lovelace,ada@example.com"], "clients.csv", {
      type: "text/csv",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText(/1 rows detected/i);
    const mappingSelects = screen.getAllByRole("combobox");
    await user.click(mappingSelects[2]);
    await user.click(await screen.findByRole("option", { name: /skip field/i }));
    await user.click(screen.getByRole("button", { name: /validate 1 rows/i }));

    await waitFor(() => {
      const validateCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url]) => String(url).includes("/api/imports/contacts/validate"),
      );
      expect(validateCall).toBeDefined();
      const form = (validateCall![1] as RequestInit).body as FormData;
      expect(JSON.parse(String(form.get("mapping")))).toMatchObject({ Email: "" });
    });
  });

  it("keeps the upload step open when the server returns a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ headers: [] }),
    })) as unknown as typeof fetch);

    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(screen.getByRole("tab", { name: /generic csv/i }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["First Name\nAda"], "clients.csv", { type: "text/csv" })] },
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/drop your csv file here/i)).toBeInTheDocument();
    expect(screen.queryByText(/rows detected/i)).not.toBeInTheDocument();
  });
});
