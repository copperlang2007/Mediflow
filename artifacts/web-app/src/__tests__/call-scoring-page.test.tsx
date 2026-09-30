// @vitest-environment jsdom
/**
 * Call scoring page: renders only what the API returns (no invented numbers),
 * says plainly what is not set up, shows each finding with its quote, speaker
 * and position, keeps human overrides and do-not-contact decisions as explicit
 * clicks, and hides reviewer/creator tools from agents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.releasePointerCapture = vi.fn();
(globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame = (cb) => (cb(), 0);

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const state = vi.hoisted(() => ({
  role: "compliance_manager",
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
  routes: {} as Record<string, (call: { url: string; method: string; body: unknown }) => unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: "u1", role: state.role }, isLoading: false }),
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call = { url: String(url), method, body };
    state.calls.push(call);
    const path = String(url).split("?")[0]!;
    const handler = state.routes[`${method} ${path}`];
    if (!handler) throw Object.assign(new Error("not mocked"), { status: 404, data: { error: "not mocked" } });
    const out = handler(call);
    if (out instanceof Error) throw out;
    return out;
  }),
}));

import CallScoringPage from "@/pages/call-scoring";

const config = (over: Record<string, unknown> = {}) => ({
  rubrics: [
    { id: "medicare-tpmo", name: "Medicare sales call", version: "2026.1", description: "", passThreshold: 80 },
    { id: "general-sales", name: "General sales call", version: "2026.1", description: "", passThreshold: 75 },
  ],
  defaultRubricId: "medicare-tpmo",
  ai: { status: "needs_setup", message: "AI review is not set up." },
  audio: { supported: false, message: "Audio transcription is not set up yet. Upload a transcript instead." },
  limits: { maxFileBytes: 1048576, maxImportFiles: 50, maxPasteChars: 500000, acceptedFormats: [".txt", ".vtt", ".srt", ".json"] },
  canCreate: true,
  canReview: true,
  disclaimer: "Call scoring assists review. It is not legal advice and not a compliance certification.",
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  truncated: false,
  totals: { total: 7, pass: 3, fail: 1, review: 3, avgScore: 81, openDnc: 2, needsReviewItems: 5 },
  byAgent: [{ agentId: "a1", name: "Dana Brooks", total: 7, pass: 3, fail: 1, review: 3, avgScore: 81 }],
  byRubric: [],
  disclaimer: "x",
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  createdAt: "2026-09-01T12:00:00.000Z",
  callDate: "2026-08-30T00:00:00.000Z",
  source: "upload",
  externalRef: "REC-1001",
  speakerMode: "labelled",
  timing: "recorded",
  contact: { id: "c1", name: "Uma Unique" },
  contactMatch: "explicit",
  agent: { id: "a1", name: "Dana Brooks" },
  rubric: { id: "medicare-tpmo", version: "2026.1" },
  score: 74,
  autoScore: 74,
  compliance: "review",
  autoCompliance: "review",
  meetsStandard: false,
  criticalFailureCount: 0,
  needsReviewCount: 2,
  openDnc: 1,
  reviewed: false,
  ai: { status: "skipped", model: null },
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  transcript: {
    id: "t1",
    source: "upload",
    format: "txt",
    externalRef: "REC-1001",
    callDate: "2026-08-30T00:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    retainUntil: "2036-09-01T12:00:00.000Z",
    speakerMode: "labelled",
    timing: "recorded",
    filename: "rec.txt",
    textAvailable: true,
    contact: { id: "c1", name: "Uma Unique" },
    contactMatch: "explicit",
    agent: { id: "a1", name: "Dana Brooks" },
  },
  utterances: [
    { id: 0, startSec: 0, endSec: 4, speaker: "Agent", role: "agent", text: "Hello, this is Dana." },
    { id: 1, startSec: 110, endSec: 116, speaker: "Agent", role: "agent", text: "Honestly this is the best plan out there." },
    { id: 2, startSec: 120, endSec: 124, speaker: "Customer", role: "client", text: "Please stop calling me." },
  ],
  disclaimer: "Call scoring assists review. It is not legal advice and not a compliance certification.",
  score: {
    id: "s1",
    createdAt: "2026-09-01T12:00:00.000Z",
    rubric: { id: "medicare-tpmo", version: "2026.1", name: "Medicare sales call", passThreshold: 80 },
    ai: { status: "needs_setup", model: null, error: null },
    auto: { score: 74, compliance: "review", criticalFailures: [], needsReview: ["informed_enrollment"] },
    effective: { score: 74, compliance: "review", criticalFailures: [], needsReview: ["informed_enrollment"], openDnc: 1, meetsStandard: false },
  },
  criteria: [
    {
      criterionId: "no_superlatives",
      name: "No unsubstantiated superlatives",
      kind: "prohibited",
      severity: "major",
      description: null,
      citation: "42 CFR 422.2262 (superlatives must be substantiated)",
      status: "fail",
      autoStatus: "fail",
      source: "rules",
      rationale: "Prohibited phrasing found (1x).",
      coaching: "Avoid 'best' claims.",
      evidence: [
        { findingId: "f1", utteranceIndex: 1, endUtteranceIndex: 1, startOffset: 17, endOffset: 30, startSeconds: 110, speaker: "agent", quote: "the best plan", componentId: null },
      ],
      human: null,
    },
    {
      criterionId: "informed_enrollment",
      name: "Informed, voluntary enrollment",
      kind: "judgment",
      severity: "critical",
      description: null,
      citation: "CMS Pre-Enrollment Checklist",
      status: "needs_review",
      autoStatus: "needs_review",
      source: "llm",
      rationale: "Needs a person or the AI reviewer: AI review is not set up or did not run.",
      coaching: null,
      evidence: [],
      human: null,
    },
  ],
  dnc: [
    { findingId: "d1", fingerprint: "dnc:2:7", utteranceIndex: 2, startOffset: 7, endOffset: 23, startSeconds: 120, speaker: "client", quote: "Please stop calling me.", status: "open", resolution: null },
  ],
  reviews: [],
  previousScores: [],
  ...over,
});

const dncItem = (over: Record<string, unknown> = {}) => ({
  findingId: "d1",
  transcriptId: "t1",
  fingerprint: "dnc:2:7",
  status: "open",
  quote: "Please stop calling me.",
  speaker: "client",
  utteranceIndex: 2,
  startSeconds: 120,
  createdAt: "2026-09-01T12:00:00.000Z",
  callDate: null,
  externalRef: "REC-1001",
  speakerMode: "labelled",
  contact: { id: "c1", name: "Uma Unique", phoneLast4: "0111" },
  contactMatch: "explicit",
  candidates: [],
  moreCandidates: false,
  numbers: [{ source: "transcript", last4: "0111" }],
  agent: { id: "a1", name: "Dana Brooks" },
  resolution: null,
  ...over,
});

function setup(routes: Record<string, (c: Call) => unknown>) {
  state.routes = {
    "GET /api/call-scoring/config": () => config(),
    "GET /api/call-scoring/summary": () => summary(),
    "GET /api/call-scoring/transcripts": () => ({ total: 1, truncated: false, items: [item()] }),
    ...routes,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CallScoringPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
});
afterEach(() => {
  state.role = "compliance_manager";
  state.routes = {};
});

describe("Call scoring page", () => {
  it("shows KPIs and rows from the API and says what is not set up", async () => {
    setup({});
    renderPage();
    expect(await screen.findByText("REC-1001")).toBeInTheDocument();
    // KPI numbers come from the summary response.
    const kpi = (label: string) => screen.getByText(label, { selector: "p" }).closest("div.relative") as HTMLElement;
    await waitFor(() => expect(within(kpi("Calls scored")).getByText("7")).toBeInTheDocument());
    expect(within(kpi("Needs review")).getByText("3")).toBeInTheDocument();
    expect(within(kpi("Failed compliance")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("Possible do-not-contact")).getByText("2")).toBeInTheDocument();
    // Honest states.
    const caps = screen.getByRole("list", { name: "What is set up" });
    expect(within(caps).getByText("Audio transcription")).toBeInTheDocument();
    expect(within(caps).getAllByText("Not set up")).toHaveLength(2); // audio + AI
    expect(within(caps).getByText(/not legal advice and not a compliance certification/i)).toBeInTheDocument();
    // Row content.
    expect(screen.getByText(/Agent Dana Brooks · Uma Unique/)).toBeInTheDocument();
    expect(screen.getByText("2 to review")).toBeInTheDocument();
    // By-agent table is real data.
    expect(screen.getByRole("cell", { name: "Dana Brooks" })).toBeInTheDocument();
  });

  it("pages the scored calls list using the API total and puts the offset in the request", async () => {
    const urls: string[] = [];
    setup({
      "GET /api/call-scoring/transcripts": (c) => {
        urls.push(c.url);
        const offset = Number(new URL(c.url, "http://x").searchParams.get("offset") ?? "0");
        return {
          total: 120,
          truncated: false,
          items: Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => item({ id: `t${offset + i}`, externalRef: `REC-${offset + i}` })),
        };
      },
    });
    renderPage();
    expect(await screen.findByText("REC-0")).toBeInTheDocument();
    expect(urls[0]).toContain("limit=50");
    expect(urls[0]).toContain("offset=0");
    const nav = screen.getByRole("navigation", { name: "Scored calls pages" });
    expect(within(nav).getByText("Showing 1-50 of 120")).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "Next" }));
    expect(await screen.findByText("REC-50")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("offset=50"))).toBe(true);
    expect(screen.getByText("Showing 51-100 of 120")).toBeInTheDocument();
    // Changing a filter goes back to the first page.
    await userEvent.click(screen.getByRole("button", { name: /Possible do-not-contact only/ }));
    await waitFor(() => expect(urls.at(-1)).toMatch(/offset=0.*dnc=open|dnc=open.*offset=0/));
    expect(await screen.findByText("REC-0")).toBeInTheDocument();
  });

  it("shows 'AI review set up' only when the API says so", async () => {
    setup({ "GET /api/call-scoring/config": () => config({ ai: { status: "configured", message: "ok" } }) });
    renderPage();
    const caps = await screen.findByRole("list", { name: "What is set up" });
    await waitFor(() => expect(within(caps).getByText("Set up")).toBeInTheDocument());
    expect(within(caps).getAllByText("Not set up")).toHaveLength(1); // audio only
  });

  it("shows an honest empty state with no invented numbers", async () => {
    setup({
      "GET /api/call-scoring/summary": () => summary({ totals: { total: 0, pass: 0, fail: 0, review: 0, avgScore: null, openDnc: 0, needsReviewItems: 0 }, byAgent: [] }),
      "GET /api/call-scoring/transcripts": () => ({ total: 0, truncated: false, items: [] }),
    });
    renderPage();
    expect(await screen.findByText("No calls scored yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing scored yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting on a person")).toBeInTheDocument();
    expect(screen.queryByText("By agent")).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Add transcripts" })[1]!);
    expect((await screen.findAllByText(/Audio transcription is not set up yet/)).length).toBeGreaterThan(0);
  });

  it("an agent sees calls but no reviewer or upload tools", async () => {
    state.role = "agent";
    setup({ "GET /api/call-scoring/config": () => config({ canCreate: false, canReview: false }) });
    renderPage();
    expect(await screen.findByText("REC-1001")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /do-not-contact/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Add transcripts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add transcripts" })).not.toBeInTheDocument();
    expect(state.calls.map((c) => c.url).some((u) => u.includes("dnc-review"))).toBe(false);
  });

  it("filters call the API with the chosen result", async () => {
    setup({});
    renderPage();
    await screen.findByText("REC-1001");
    await userEvent.click(screen.getByRole("button", { name: /Failed compliance/ }));
    await waitFor(() => expect(state.calls.some((c) => c.url.includes("compliance=fail"))).toBe(true));
  });
});

describe("Call detail", () => {
  it("shows each finding with quote, speaker and position, jumps to the words, and lists honest caveats", async () => {
    setup({
      "GET /api/call-scoring/transcripts/t1": () =>
        detail({
          transcript: { ...detail().transcript, speakerMode: "partial", timing: "estimated" },
        }),
    });
    renderPage();
    await userEvent.click(await screen.findByText("REC-1001"));
    const finding = await screen.findByTestId("criterion-no_superlatives");
    expect(within(finding).getByText("“the best plan”")).toBeInTheDocument();
    expect(within(finding).getByText("Agent")).toBeInTheDocument();
    expect(within(finding).getByText("at 1:50")).toBeInTheDocument();
    expect(within(finding).getByText(/42 CFR 422.2262/)).toBeInTheDocument();
    // Caveats are stated.
    const about = screen.getByRole("list", { name: "About this score" });
    expect(within(about).getByText(/Only one side of the call is labelled/)).toBeInTheDocument();
    expect(within(about).getByText(/times are estimated from word counts/)).toBeInTheDocument();
    expect(within(about).getByText(/AI review is not set up/)).toBeInTheDocument();
    // Click-to-jump highlights exactly the quoted words in the transcript.
    await userEvent.click(within(finding).getByRole("button", { name: /Jump to it/ }));
    const mark = await screen.findByTestId("jump-highlight");
    expect(mark.textContent).toBe("the best plan");
    // A needs-review criterion has no invented evidence.
    const unreviewed = screen.getByTestId("criterion-informed_enrollment");
    expect(within(unreviewed).getByText("Needs review")).toBeInTheDocument();
    // The disclaimer is on the page and again inside the call.
    expect(screen.getAllByText(/not legal advice and not a compliance certification/i).length).toBeGreaterThanOrEqual(2);
  });

  it("the do-not-contact controls in the call view offer the same number choices as the queue", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/transcripts/t1": () => detail(),
      "GET /api/call-scoring/dnc-review": () => ({ items: [dncItem({ transcriptId: "t1", findingId: "d1" })], total: 1, note: "n" }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await userEvent.click(await screen.findByText("REC-1001"));
    const region = await screen.findByRole("region", { name: "Possible do-not-contact requests" });
    const confirm = await within(region).findByRole("button", { name: "Add to do-not-contact list" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(region).getByLabelText(/Number ending 0111 \(given with this call\)/));
    await userEvent.click(confirm);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript" });
    expect(state.calls.some((c) => c.url.includes("dnc-review?") && c.url.includes("transcriptId=t1"))).toBe(true);
  });

  it("saves a human override with a required note and never edits the automatic result", async () => {
    let saved: Call | null = null;
    setup({
      "GET /api/call-scoring/transcripts/t1": () => detail(),
      "PATCH /api/call-scoring/transcripts/t1/criteria/informed_enrollment": (c) => ((saved = c), detail()),
    });
    renderPage();
    await userEvent.click(await screen.findByText("REC-1001"));
    const crit = await screen.findByTestId("criterion-informed_enrollment");
    await userEvent.click(within(crit).getByRole("button", { name: "Grade this item" }));
    const save = within(crit).getByRole("button", { name: "Save my grade" });
    expect(save).toBeDisabled();
    await userEvent.type(within(crit).getByLabelText(/Why\?/), "No enrollment on this call.");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved!.body).toEqual({ verdict: "pass", note: "No enrollment on this call." });
  });

  it("shows the reviewed grade next to the automatic one", async () => {
    setup({
      "GET /api/call-scoring/transcripts/t1": () =>
        detail({
          criteria: [
            {
              ...detail().criteria[1],
              status: "na",
              autoStatus: "needs_review",
              human: { verdict: "na", note: "Not an enrollment call.", reviewerName: "Casey Compliance", reviewerRole: "compliance_manager", at: "2026-09-02T12:00:00.000Z" },
            },
          ],
        }),
    });
    renderPage();
    await userEvent.click(await screen.findByText("REC-1001"));
    const crit = await screen.findByTestId("criterion-informed_enrollment");
    expect(within(crit).getByText("Automatic: Needs review")).toBeInTheDocument();
    expect(within(crit).getByText("Not applicable (reviewed)")).toBeInTheDocument();
    expect(within(crit).getByText(/Casey Compliance graded this/)).toBeInTheDocument();
    expect(within(crit).getByRole("button", { name: /Go back to the automatic grade/ })).toBeInTheDocument();
  });

  it("an agent cannot see override or do-not-contact controls", async () => {
    state.role = "agent";
    setup({
      "GET /api/call-scoring/config": () => config({ canCreate: false, canReview: false }),
      "GET /api/call-scoring/transcripts/t1": () => detail(),
    });
    renderPage();
    await userEvent.click(await screen.findByText("REC-1001"));
    await screen.findByTestId("criterion-no_superlatives");
    expect(screen.queryByRole("button", { name: /Grade this item|Override the grade/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to do-not-contact list" })).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for a compliance reviewer.")).toBeInTheDocument();
  });
});

describe("Possible do-not-contact requests tab", () => {
  const openTab = async () => {
    await userEvent.click(await screen.findByRole("tab", { name: /Possible do-not-contact requests/ }));
  };

  it("lists the exact quote and adds an opt-out only when the reviewer clicks", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({ items: [dncItem()], total: 1, note: "n" }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByText("“Please stop calling me.”")).toBeInTheDocument();
    expect(within(row).getByText(/Client · at 2:00/)).toBeInTheDocument();
    expect(within(row).getByText("Uma Unique")).toBeInTheDocument();
    // Nothing has been sent yet.
    expect(posted).toBeNull();
    expect(state.calls.some((c) => c.method === "POST")).toBe(false);
    // The reviewer must confirm which number asked to stop before anything can be sent.
    const confirmBtn = within(row).getByRole("button", { name: "Add to do-not-contact list" });
    expect(confirmBtn).toBeDisabled();
    expect(within(row).getByText(/Only this number is added/)).toBeInTheDocument();
    await userEvent.click(within(row).getByLabelText(/Number ending 0111 \(given with this call\)/));
    expect(confirmBtn).toBeEnabled();
    await userEvent.click(confirmBtn);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript" });
  });

  it("dismissing needs a note", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({ items: [dncItem()], total: 1, note: "n" }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "dismiss", optOut: null }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    await userEvent.click(within(row).getByRole("button", { name: "Not a request" }));
    const save = within(row).getByRole("button", { name: "Save dismissal" });
    expect(save).toBeDisabled();
    await userEvent.type(within(row).getByLabelText(/Why is this not a request/), "Client was joking.");
    await userEvent.click(save);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "dismiss", note: "Client was joking." });
  });

  it("makes the reviewer pick a client when the phone matches several", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [
          dncItem({
            contact: null,
            contactMatch: "phone_ambiguous",
            candidates: [
              { id: "cA", name: "Dee Dup", phoneLast4: "0122" },
              { id: "cB", name: "Dot Dup", phoneLast4: "0122" },
            ],
          }),
        ],
        total: 1,
        note: "n",
      }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "cB" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByText(/More than one client uses this phone number/)).toBeInTheDocument();
    const confirm = within(row).getByRole("button", { name: "Add to do-not-contact list" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(row).getByLabelText(/Dot Dup/));
    expect(confirm).toBeDisabled(); // a client is picked, but the number is not confirmed yet
    await userEvent.click(within(row).getByLabelText(/Number ending 0111/));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript", contactId: "cB" });
  });

  it("asks for a phone number when the server says none is on file", async () => {
    const calls: Call[] = [];
    setup({
      "GET /api/call-scoring/dnc-review": () => ({ items: [dncItem({ contact: null, contactMatch: "none", numbers: [] })], total: 1, note: "n" }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => {
        calls.push(c);
        return { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: null } };
      },
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    // No number on file: the only choice is to type one.
    const confirm = within(row).getByRole("button", { name: "Add to do-not-contact list" });
    expect(confirm).toBeDisabled();
    expect(within(row).queryByLabelText(/Number ending/)).not.toBeInTheDocument();
    await userEvent.click(within(row).getByLabelText("A different number (type it)"));
    expect(confirm).toBeDisabled(); // still needs the number itself
    await userEvent.type(within(row).getByLabelText("Phone number to add"), "(310) 555-0155");
    await userEvent.click(confirm);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ action: "add_opt_out", phoneSource: "typed", phone: "(310) 555-0155" });
  });

  it("lets the reviewer search for the client when more share the number than can be listed", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [
          dncItem({
            contact: null,
            contactMatch: "phone_ambiguous",
            moreCandidates: true,
            candidates: [{ id: "cA", name: "Dee Dup", phoneLast4: "0122" }],
          }),
        ],
        total: 1,
        note: "n",
      }),
      "GET /api/contacts": () => ({ data: [{ id: "cZ", firstName: "Zed", lastName: "Late", phone: "(310) 555-0122" }] }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "cZ" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByText(/More clients share this number than are listed/)).toBeInTheDocument();
    await userEvent.type(within(row).getByLabelText("Search for the client"), "Zed");
    await userEvent.click(await within(row).findByLabelText(/Zed Late/));
    await userEvent.click(within(row).getByLabelText(/Number ending 0111/));
    await userEvent.click(within(row).getByRole("button", { name: "Add to do-not-contact list" }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript", contactId: "cZ" });
  });

  it("pages through the queue with offset in the request", async () => {
    const offsets: string[] = [];
    setup({
      "GET /api/call-scoring/dnc-review": (c) => {
        const offset = new URL(c.url, "http://x").searchParams.get("offset") ?? "0";
        offsets.push(offset);
        const start = Number(offset);
        return {
          items: Array.from({ length: Math.min(50, 120 - start) }, (_, i) => dncItem({ findingId: `d${start + i}`, fingerprint: `f${start + i}` })),
          total: 120,
          note: "n",
        };
      },
    });
    renderPage();
    await openTab();
    await screen.findAllByTestId("dnc-item");
    const nav = screen.getByRole("navigation", { name: "Requests pages" });
    expect(within(nav).getByText("Showing 1-50 of 120")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(within(nav).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(offsets).toContain("50"));
    expect(await screen.findByText("Showing 51-100 of 120")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 101-120 of 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Showing 51-100 of 120")).toBeInTheDocument();
  });

  it("an email-only request is resolved through the email opt-out: no number to pick, a client is required", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [dncItem({ channel: "email", emailOnFile: true, numbers: [], quote: "Please stop emailing me." })],
        total: 1,
        note: "n",
      }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { channel: "email", emailsRecorded: 1, phonesRecorded: 0, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByText(/request to stop/)).toHaveTextContent(/email/);
    expect(within(row).queryByLabelText(/Number ending/)).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Add to do-not-contact list" }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out" });
  });

  it("an email-only request with no client asks the reviewer to pick one first", async () => {
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [dncItem({ channel: "email", emailOnFile: null, numbers: [], contact: null, contactMatch: "none" })],
        total: 1,
        note: "n",
      }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByRole("button", { name: "Add to do-not-contact list" })).toBeDisabled();
    expect(within(row).getByLabelText("Search for the client")).toBeInTheDocument();
  });

  it("shows the email coupling with a masked address, checked by default, and unchecking skips it", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [dncItem({ contact: { id: "c1", name: "Uma Unique", phoneLast4: "0111", maskedEmail: "u***@example.com" }, emailOnFile: true })],
        total: 1,
        note: "n",
      }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(within(row).getByText("u***@example.com")).toBeInTheDocument();
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(box.checked).toBe(false);
    await userEvent.click(within(row).getByLabelText(/Number ending 0111/));
    await userEvent.click(within(row).getByRole("button", { name: "Add to do-not-contact list" }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript", alsoOptOutEmail: false });
  });

  it("with the coupling left on, the choice is sent as true", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [dncItem({ contact: { id: "c1", name: "Uma Unique", phoneLast4: "0111", maskedEmail: "u***@example.com" } })],
        total: 1,
        note: "n",
      }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, emailsRecorded: 1, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    await userEvent.click(within(row).getByLabelText(/Number ending 0111/));
    await userEvent.click(within(row).getByRole("button", { name: "Add to do-not-contact list" }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", phoneSource: "transcript", alsoOptOutEmail: true });
  });

  it("when the words do not name a channel the reviewer chooses one, and the choice is sent", async () => {
    let posted: Call | null = null;
    setup({
      "GET /api/call-scoring/dnc-review": () => ({
        items: [dncItem({ channel: "email", channelAssumed: true, emailOnFile: true, quote: "Please unsubscribe me from your list." })],
        total: 1,
        note: "n",
      }),
      "POST /api/call-scoring/dnc-review/d1/resolve": (c) => ((posted = c), { status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: 1, alreadyOnList: 0, contactId: "c1" } }),
    });
    renderPage();
    await openTab();
    const row = await screen.findByTestId("dnc-item");
    expect(within(row).getByText(/do not say which kind of contact/)).toBeInTheDocument();
    expect((within(row).getByLabelText("Email") as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(row).getByLabelText("Phone calls and texts"));
    await userEvent.click(within(row).getByLabelText(/Number ending 0111/));
    await userEvent.click(within(row).getByRole("button", { name: "Add to do-not-contact list" }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.body).toEqual({ action: "add_opt_out", channel: "phone", phoneSource: "transcript" });
  });

  it("shows an honest empty state", async () => {
    setup({ "GET /api/call-scoring/dnc-review": () => ({ items: [], total: 0, note: "n" }) });
    renderPage();
    await openTab();
    expect(await screen.findByText("No possible requests waiting")).toBeInTheDocument();
  });
});

describe("Add transcripts", () => {
  it("posts pasted text and shows the result with its honest notes", async () => {
    let posted: Call | null = null;
    setup({
      "POST /api/call-scoring/transcripts": (c) => (
        (posted = c),
        {
          transcriptId: "t9",
          score: 62,
          compliance: "fail",
          dncFlagCount: 1,
          notes: [{ code: "ai_needs_setup", message: "AI review is not set up, so judgment items are marked needs review." }],
        }
      ),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Add transcripts" }));
    expect(screen.getAllByText(/Audio transcription is not set up yet/).length).toBeGreaterThan(0);
    const submit = screen.getByRole("button", { name: "Score transcript" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Transcript text"), "Agent: hello");
    await userEvent.click(submit);
    const result = await screen.findByTestId("single-result");
    expect(within(result).getByText("62")).toBeInTheDocument();
    expect(within(result).getByText("Failed")).toBeInTheDocument();
    expect(within(result).getByText("1 possible do-not-contact")).toBeInTheDocument();
    expect(within(result).getByText(/AI review is not set up/)).toBeInTheDocument();
    expect((posted!.body as FormData).get("text")).toBe("Agent: hello");
  });

  it("shows the server's plain-language refusal (for example audio)", async () => {
    setup({
      "POST /api/call-scoring/transcripts": () =>
        Object.assign(new Error("x"), { status: 415, data: { error: "Audio transcription is not set up yet, so recordings can't be scored directly.", code: "audio_transcription_not_set_up" } }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Add transcripts" }));
    await userEvent.type(screen.getByLabelText("Transcript text"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Score transcript" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/recordings can't be scored directly/);
  });

  it("imports a batch and summarises real results, including possible do-not-contact hits", async () => {
    setup({
      "POST /api/call-scoring/import": () => ({
        summary: {
          files: 3,
          scored: 2,
          duplicates: 0,
          errors: 1,
          byCompliance: { pass: 0, fail: 1, review: 1 },
          possibleDncFiles: 1,
          possibleDncRequests: 1,
          unlabelledSpeakers: 1,
          needContactPick: 0,
          notLinkedToClient: 2,
          filesWithWarnings: 1,
          agentAmbiguousName: 1,
          agentNotFound: 2,
          manifest: { rows: 3, unmatchedManifestRows: 0, problems: [] },
          aiReview: "Not run for bulk imports.",
          note: "n",
        },
        results: [
          { filename: "a.txt", status: "scored", compliance: "fail", score: 40, dncFlags: 1, warnings: [] },
          { filename: "b.txt", status: "scored", compliance: "review", score: 70, dncFlags: 0, warnings: ["Not listed in the manifest, so it has no phone, agent or date."] },
          { filename: "c.mp3", status: "error", error: "Audio transcription is not set up yet.", warnings: [] },
        ],
      }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Add transcripts" }));
    const input = screen.getByLabelText("Transcript files") as HTMLInputElement;
    await userEvent.upload(input, [new File(["Agent: hi"], "a.txt", { type: "text/plain" }), new File(["Agent: yo"], "b.txt", { type: "text/plain" })]);
    await userEvent.click(screen.getByRole("button", { name: "Import and score" }));
    const out = await screen.findByTestId("import-result");
    expect(within(out).getByText("2 of 3")).toBeInTheDocument();
    expect(within(out).getByRole("button", { name: /Review the 1 possible do-not-contact request/ })).toBeInTheDocument();
    expect(within(out).getByText("c.mp3")).toBeInTheDocument();
    expect(within(out).getByText("Not scored")).toBeInTheDocument();
    expect(within(out).getByText(/Audio transcription is not set up yet\./)).toBeInTheDocument();
    expect(within(out).getByText(/Not listed in the manifest/)).toBeInTheDocument();
    expect(within(out).getByText(/2 had an agent in the manifest that was not found/)).toBeInTheDocument();
    expect(within(out).getByText(/1 had an agent name that matches more than one person/)).toBeInTheDocument();
    expect(within(out).getByText(/1 file has warnings/)).toBeInTheDocument();
  });
});
