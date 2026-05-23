// @vitest-environment jsdom
/**
 * Component tests for the admin Carriers page.
 *
 * The page renders the carrier table from `useGetCarriers` (seeded via the
 * QueryClient cache), opens an edit dialog when a row is clicked, validates
 * the appointment-desk email client-side, and PATCHes via `apiFetch`. We
 * mock `fetch` so the test never crosses the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getGetCarriersQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import AdminCarriersPage, {
  buildCarrierPayload,
  carrierToForm,
  isValidEmail,
  CarrierEditDialog,
  type AdminCarrier,
} from "@/pages/admin-carriers";

const ADMIN_USER = {
  id: "u-admin",
  orgId: "o-1",
  email: "admin@example.com",
  fullName: "Admin User",
  role: "agency_admin",
  isActive: true,
};

const SAMPLE_CARRIERS: AdminCarrier[] = [
  {
    id: "carrier-aetna",
    orgId: "o-1",
    name: "Aetna/CVS",
    cmsContractNumber: "H1234",
    logoUrl: null,
    isActive: true,
    appointmentDeskEmail: "appointments@aetna-cvs.example",
    appointmentDeskMetadata: {
      cc: ["compliance@insureitall.example"],
      subject: "New agent appointment packet",
    },
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "carrier-humana",
    orgId: "o-1",
    name: "Humana",
    cmsContractNumber: null,
    logoUrl: null,
    isActive: true,
    appointmentDeskEmail: null,
    appointmentDeskMetadata: null,
    createdAt: "2025-01-01T00:00:00Z",
  },
];

function makeClient(carriers: AdminCarrier[] | null = SAMPLE_CARRIERS): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  qc.setQueryData(getGetMeQueryKey(), ADMIN_USER);
  if (carriers !== null) {
    qc.setQueryData(getGetCarriersQueryKey(), carriers);
  }
  return qc;
}

function renderPage(qc: QueryClient) {
  const { hook } = memoryLocation({ path: "/admin-carriers", static: true });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TooltipProvider>
          <AdminCarriersPage />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

function renderDialog(props: {
  editing: AdminCarrier | "new" | null;
  onClose?: () => void;
}) {
  const qc = makeClient([]);
  const { hook } = memoryLocation({ path: "/admin-carriers", static: true });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <TooltipProvider>
            <CarrierEditDialog
              editing={props.editing}
              onClose={props.onClose ?? (() => {})}
            />
          </TooltipProvider>
        </Router>
      </QueryClientProvider>,
    ),
  };
}

describe("AdminCarriersPage pure helpers", () => {
  it("isValidEmail accepts well-formed addresses", () => {
    expect(isValidEmail("foo@bar.com")).toBe(true);
    expect(isValidEmail("Carlos.reyes+demo@insureitall.example")).toBe(true);
  });

  it("isValidEmail rejects junk", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("foo@bar")).toBe(false);
    expect(isValidEmail("a b@c.d")).toBe(false);
  });

  it("buildCarrierPayload serializes cc + subject into metadata", () => {
    const payload = buildCarrierPayload({
      name: "Aetna",
      cmsContractNumber: "H123",
      logoUrl: "",
      isActive: true,
      appointmentDeskEmail: "desk@aetna.example",
      appointmentDeskCc: "compliance@x.example, ops@x.example",
      appointmentDeskSubject: "New packet",
    });
    expect(payload).not.toBeNull();
    expect(payload!.appointmentDeskMetadata).toEqual({
      cc: ["compliance@x.example", "ops@x.example"],
      subject: "New packet",
    });
    expect(payload!.cmsContractNumber).toBe("H123");
    expect(payload!.logoUrl).toBeNull();
  });

  it("buildCarrierPayload rejects an invalid desk email", () => {
    const payload = buildCarrierPayload({
      name: "Aetna",
      cmsContractNumber: "",
      logoUrl: "",
      isActive: true,
      appointmentDeskEmail: "not-an-email",
      appointmentDeskCc: "",
      appointmentDeskSubject: "",
    });
    expect(payload).toBeNull();
  });

  it("buildCarrierPayload requires a name", () => {
    const payload = buildCarrierPayload({
      name: "   ",
      cmsContractNumber: "",
      logoUrl: "",
      isActive: true,
      appointmentDeskEmail: "",
      appointmentDeskCc: "",
      appointmentDeskSubject: "",
    });
    expect(payload).toBeNull();
  });

  it("carrierToForm round-trips through buildCarrierPayload", () => {
    const form = carrierToForm(SAMPLE_CARRIERS[0]!);
    const payload = buildCarrierPayload(form);
    expect(payload).not.toBeNull();
    expect(payload!.name).toBe("Aetna/CVS");
    expect(payload!.appointmentDeskEmail).toBe(
      "appointments@aetna-cvs.example",
    );
    expect(payload!.appointmentDeskMetadata.cc).toEqual([
      "compliance@insureitall.example",
    ]);
  });
});

describe("AdminCarriersPage rendering", () => {
  beforeEach(() => {
    if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it("renders the carriers table when data is present", () => {
    renderPage(makeClient());
    expect(screen.getByTestId("carriers-table")).toBeInTheDocument();
    expect(screen.getByText("Aetna/CVS")).toBeInTheDocument();
    expect(screen.getByText("Humana")).toBeInTheDocument();
    expect(
      screen.getByText("appointments@aetna-cvs.example"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("filters by search input", () => {
    renderPage(makeClient());
    const input = screen.getByTestId("carrier-search");
    fireEvent.change(input, { target: { value: "Hum" } });
    expect(screen.queryByText("Aetna/CVS")).not.toBeInTheDocument();
    expect(screen.getByText("Humana")).toBeInTheDocument();
  });

  it("opens the edit dialog when a row is clicked", () => {
    renderPage(makeClient());
    fireEvent.click(screen.getByTestId("carrier-row-carrier-aetna"));
    const dialog = screen.getByTestId("carrier-edit-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByTestId("cf-name")).toHaveValue("Aetna/CVS");
    expect(within(dialog).getByTestId("cf-desk-email")).toHaveValue(
      "appointments@aetna-cvs.example",
    );
  });
});

describe("CarrierEditDialog form behavior", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("blocks save when the desk email is invalid and surfaces an inline error", async () => {
    renderDialog({ editing: "new" });
    fireEvent.change(screen.getByTestId("cf-name"), {
      target: { value: "New Carrier" },
    });
    fireEvent.change(screen.getByTestId("cf-desk-email"), {
      target: { value: "garbage" },
    });
    fireEvent.click(screen.getByTestId("carrier-save-btn"));
    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the carrier on save with the metadata payload shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...SAMPLE_CARRIERS[0], name: "Aetna v2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderDialog({ editing: SAMPLE_CARRIERS[0]! });

    fireEvent.change(screen.getByTestId("cf-name"), {
      target: { value: "Aetna v2" },
    });
    fireEvent.change(screen.getByTestId("cf-desk-subj"), {
      target: { value: "Subject v2" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("carrier-save-btn"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/carriers\/carrier-aetna$/);
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.name).toBe("Aetna v2");
    expect(body.appointmentDeskMetadata.subject).toBe("Subject v2");
    expect(body.appointmentDeskMetadata.cc).toEqual([
      "compliance@insureitall.example",
    ]);
  });
});
