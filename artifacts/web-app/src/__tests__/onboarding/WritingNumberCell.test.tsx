// @vitest-environment jsdom
/**
 * Render + interaction tests for the inline WritingNumberCell on the
 * admin onboarding detail page.
 *
 * The cell wraps `useRecordWritingNumber`, which hits
 * `PATCH /admin/contracting/:requestId`. We stub `apiFetch` so the
 * mutation resolves synchronously, then assert on:
 *   - The cell only exposes the entry input once the request is in
 *     submitted/under_review/appointed.
 *   - Save fires PATCH with the right body.
 *   - The empty/whitespace case is rejected client-side without firing
 *     a request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
    message: (msg: string) => toastSuccess(msg),
  },
}));

import { WritingNumberCell } from "@/pages/admin-onboarding-detail";
import type { CarrierContractingRequest } from "@/lib/onboarding/api";

function mkReq(
  overrides: Partial<CarrierContractingRequest>,
): CarrierContractingRequest {
  return {
    id: "req-test-1",
    orgId: "org-1",
    onboardingRunId: "run-1",
    agentId: "agent-1",
    carrierId: "carrier-1",
    states: ["FL"],
    status: "submitted",
    paperworkDocumentId: null,
    signatureCompletedAt: null,
    writingNumber: null,
    lastStatusChangeAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderCell(req: CarrierContractingRequest) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WritingNumberCell request={req} agentId="agent-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("WritingNumberCell", () => {
  it("shows a dash for requests not yet in a writing-number-ready status", () => {
    renderCell(mkReq({ status: "paperwork_generated" }));
    expect(screen.queryByText(/Enter writing #/i)).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows 'Enter writing #' once the request is submitted", () => {
    renderCell(mkReq({ status: "submitted" }));
    expect(screen.getByTestId("add-writing-num-req-test-1")).toBeInTheDocument();
  });

  it("PATCHes the backend with the entered writing number", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      request: {
        ...mkReq({}),
        writingNumber: "W-123456",
        status: "appointed",
      },
      idempotent: false,
    });

    renderCell(mkReq({ status: "submitted" }));
    await user.click(screen.getByTestId("add-writing-num-req-test-1"));

    const input = screen.getByPlaceholderText("e.g. W-1234567");
    await user.type(input, "W-123456");
    await user.click(screen.getByTestId("save-writing-num-req-test-1"));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe("/api/admin/contracting/req-test-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ writingNumber: "W-123456" });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("rejects an empty writing number without firing a PATCH", async () => {
    const user = userEvent.setup();
    renderCell(mkReq({ status: "submitted" }));
    await user.click(screen.getByTestId("add-writing-num-req-test-1"));
    await user.click(screen.getByTestId("save-writing-num-req-test-1"));

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Writing number is required");
  });

  it("renders the existing writing number for an appointed request and re-enters edit mode on click", async () => {
    const user = userEvent.setup();
    renderCell(
      mkReq({ status: "appointed", writingNumber: "W-EXISTING-1" }),
    );
    expect(screen.getByText("W-EXISTING-1")).toBeInTheDocument();
    await user.click(screen.getByText("W-EXISTING-1"));
    expect(screen.getByPlaceholderText("e.g. W-1234567")).toBeInTheDocument();
  });

  it("surfaces a backend error via toast and keeps the editor open", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValueOnce(new Error("Boom"));

    renderCell(mkReq({ status: "submitted" }));
    await user.click(screen.getByTestId("add-writing-num-req-test-1"));
    await user.type(
      screen.getByPlaceholderText("e.g. W-1234567"),
      "W-1",
    );
    await user.click(screen.getByTestId("save-writing-num-req-test-1"));

    expect(toastError).toHaveBeenCalledWith("Boom");
    // Editor is still open (Save button still rendered).
    expect(
      screen.getByTestId("save-writing-num-req-test-1"),
    ).toBeInTheDocument();
  });
});
