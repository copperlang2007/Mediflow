// @vitest-environment jsdom
/**
 * EnrollHere call-log import: sends the CSV with the IIA 2026 checklist by
 * default, then reports what was stored, sent for scoring and skipped.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
  reply: null as unknown,
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    state.calls.push({ url: String(url), method: (init?.method ?? "GET").toUpperCase(), body: init?.body });
    if (state.reply instanceof Error) throw state.reply;
    return state.reply;
  }),
}));

import { EnrollhereCallLogImport, type CallLogSummary } from "@/components/call-scoring/EnrollhereCallLogImport";
import type { CsConfig } from "@/components/call-scoring/shared";

const config = (supported = true): CsConfig =>
  ({
    rubrics: [
      { id: "medicare-tpmo", name: "Medicare TPMO", version: "1", description: "", passThreshold: 80 },
      { id: "iia-2026-qa", name: "IIA 2026 QA", version: "1", description: "", passThreshold: 80 },
    ],
    defaultRubricId: "medicare-tpmo",
    ai: { status: "needs_setup", message: "" },
    audio: supported ? { supported: true, message: "ok" } : { supported: false, message: "not set up" },
    limits: { maxFileBytes: 1, maxImportFiles: 1, maxPasteChars: 1, acceptedFormats: [] },
    canCreate: true,
    canReview: true,
    disclaimer: "",
  }) as CsConfig;

const summary = (over: Partial<CallLogSummary> = {}): CallLogSummary => ({
  rows: 4,
  stored: 4,
  duplicates: 0,
  queued: 1,
  requeued: 0,
  notScored: { short: 1, noRecording: 1, badLink: 1, notTranscribed: 0 },
  errors: 0,
  unreadable: [],
  results: [{ line: 5, callId: "call-badlink", outcome: "stored_bad_link", message: "The recording link is not an EnrollHere recording link, so it was not downloaded." }],
  ...over,
});

function renderIt(supported = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EnrollhereCallLogImport config={config(supported)} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.reply = summary();
});

describe("EnrollHere call-log import", () => {
  it("uploads the CSV scored with IIA 2026 by default and shows the outcome", async () => {
    renderIt();
    const file = new File(["ID,Recording URL\n"], "Call_Logs.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Call-log CSV"), file);
    await userEvent.click(screen.getByRole("button", { name: /import call log/i }));
    await waitFor(() => expect(screen.getByTestId("call-log-result")).toBeTruthy());
    const call = state.calls[0]!;
    expect(call).toMatchObject({ url: "/api/call-scoring/enrollhere-call-log", method: "POST" });
    const fd = call.body as FormData;
    expect((fd.get("file") as File).name).toBe("Call_Logs.csv");
    expect(fd.get("rubricId")).toBe("iia-2026-qa");
    expect(screen.getByText(/under a minute/i)).toBeTruthy();
    expect(screen.getByText(/Line 5/)).toBeTruthy();
    expect(screen.getByText(/not an EnrollHere recording link/i)).toBeTruthy();
  });

  it("shows the server's message when the file is not a call log", async () => {
    state.reply = Object.assign(new Error("400"), { data: { error: 'This does not look like an EnrollHere call log: it needs the "ID" and "Recording URL" columns.' } });
    renderIt();
    await userEvent.upload(screen.getByLabelText("Call-log CSV"), new File(["a,b\n"], "x.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: /import call log/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not look like an EnrollHere call log/);
  });

  it("says calls are stored but not scored when transcription is not set up", () => {
    renderIt(false);
    expect(screen.getByText(/stored but not scored/i)).toBeTruthy();
  });
});
