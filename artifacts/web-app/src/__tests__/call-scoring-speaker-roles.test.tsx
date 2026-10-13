// @vitest-environment jsdom
/**
 * "Which voice is the agent?" on a one-track recording: shown only to reviewers
 * and only when the voices were told apart but not named; nothing is sent until
 * a reviewer clicks; the choice goes to the server with the call's checklist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.releasePointerCapture = vi.fn();

const state = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
  detail: null as unknown,
  failPost: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    state.calls.push({ url: String(url), method, body });
    if (method === "POST") {
      if (state.failPost) throw Object.assign(new Error("x"), { status: 422, data: { error: "That voice is not in this call." } });
      return { transcriptId: "t1" };
    }
    return state.detail;
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CallDetail } from "@/components/call-scoring/CallDetail";

type Role = "agent" | "client" | "unknown";
const voices = (r1: Role = "unknown", r2: Role = "unknown") => [
  { label: "Speaker 1", turns: 2, role: r1 },
  { label: "Speaker 2", turns: 3, role: r2 },
];

function detail(over: { assignable?: boolean; speakers?: ReturnType<typeof voices>; assignedAt?: string | null; omit?: boolean; scoreCurrent?: boolean; withCriterion?: boolean } = {}) {
  const assignable = over.assignable ?? true;
  const transcript: Record<string, unknown> = {
    id: "t1",
    source: "recording",
    format: "json",
    externalRef: null,
    callDate: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    retainUntil: "2036-09-01T12:00:00.000Z",
    speakerMode: "unlabelled",
    timing: "recorded",
    filename: null,
    textAvailable: true,
    contact: null,
    contactMatch: "none",
    agent: null,
  };
  if (!over.omit) {
    transcript.speakers = { assignable, speakers: assignable ? (over.speakers ?? voices()) : [] };
    transcript.speakerAssignedAt = over.assignedAt ?? null;
    transcript.speakerScoreCurrent = over.scoreCurrent ?? true;
  }
  return {
    transcript,
    utterances: [
      { id: 0, startSec: 0, endSec: 4, speaker: "Speaker 2", role: "unknown", text: "Thank you for calling Sunrise Benefits." },
      { id: 1, startSec: 5, endSec: 6, speaker: "Speaker 1", role: "unknown", text: "Okay." },
    ],
    disclaimer: "d",
    score: {
      id: "s1",
      createdAt: "2026-09-01T12:00:00.000Z",
      rubric: { id: "iia-2026", version: "1", name: "IIA", passThreshold: 80 },
      ai: { status: "needs_setup", model: null, error: null },
      auto: { score: 50, compliance: "review", criticalFailures: [], needsReview: [] },
      effective: { score: 50, compliance: "review", criticalFailures: [], needsReview: [], openDnc: 0, meetsStandard: false },
    },
    criteria: over.withCriterion
      ? [
          {
            criterionId: "tpmo_disclaimer",
            name: "TPMO disclaimer",
            kind: "required",
            severity: "critical",
            description: null,
            citation: null,
            status: "pass",
            autoStatus: "pass",
            source: "rules",
            rationale: "",
            coaching: null,
            evidence: [],
            human: null,
          },
        ]
      : [],
    dnc: [],
    reviews: [],
    previousScores: [],
  };
}

function renderDetail(canReview = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CallDetail transcriptId="t1" canReview={canReview} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.failPost = false;
  state.detail = detail();
});

describe("which voice is the agent", () => {
  it("offers each voice with a taste of what it said, and sends nothing until clicked", async () => {
    renderDetail();
    expect(await screen.findByText("Which voice is the agent?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speaker 1 is the agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Speaker 2 is the agent" })).toBeEnabled();
    expect(screen.getByText(/starts “Thank you for calling Sunrise Benefits\.”/)).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the chosen voice with the call's checklist", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Speaker 2 is the agent" }));
    await waitFor(() => expect(state.calls.some((c) => c.method === "POST")).toBe(true));
    const post = state.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/call-scoring/transcripts/t1/agent-speaker");
    expect(post.body).toEqual({ agentSpeaker: "Speaker 2", rubricId: "iia-2026" });
  });

  it("after a choice, the chosen voice is marked, and either voice can still be pressed to correct or retry", async () => {
    state.detail = detail({ speakers: voices("client", "agent"), assignedAt: "2026-09-02T12:00:00.000Z", scoreCurrent: true });
    renderDetail();
    expect(await screen.findByText("Who is the agent on this call?")).toBeInTheDocument();
    expect(screen.getByText("Chosen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speaker 2 is the agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Speaker 1 is the agent" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("when scoring again failed (the score predates the choice), says so, and the chosen voice can be pressed again", async () => {
    state.detail = detail({ speakers: voices("client", "agent"), assignedAt: "2026-09-02T12:00:00.000Z", scoreCurrent: false });
    renderDetail();
    expect(await screen.findByRole("alert")).toHaveTextContent(/score shown was made before this choice/i);
    await userEvent.click(screen.getByRole("button", { name: "Speaker 2 is the agent" }));
    await waitFor(() => expect(state.calls.some((c) => c.method === "POST")).toBe(true));
  });

  it("does not depend on the clocks of two machines agreeing", async () => {
    // A save that worked, with the choice stamped some seconds after the score by a skewed clock.
    state.detail = detail({ speakers: voices("client", "agent"), assignedAt: "2026-09-01T12:00:09.000Z", scoreCurrent: true });
    renderDetail();
    await screen.findByText("Who is the agent on this call?");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers grading while the score matches the saved choice", async () => {
    state.detail = detail({ speakers: voices("client", "agent"), assignedAt: "2026-09-02T12:00:00.000Z", scoreCurrent: true, withCriterion: true });
    renderDetail();
    expect(await screen.findByRole("button", { name: /Grade this item|Override the grade/ })).toBeInTheDocument();
  });

  it("does not offer grading while the score predates a saved speaker choice", async () => {
    state.detail = detail({ speakers: voices("client", "agent"), assignedAt: "2026-09-02T12:00:00.000Z", scoreCurrent: false, withCriterion: true });
    renderDetail();
    await screen.findByText("TPMO disclaimer");
    expect(screen.queryByRole("button", { name: /Grade this item|Override the grade/ })).not.toBeInTheDocument();
  });

  it("is hidden from people who cannot review", async () => {
    renderDetail(false);
    await screen.findByText(/Thank you for calling Sunrise Benefits\./);
    expect(screen.queryByTestId("speaker-roles")).not.toBeInTheDocument();
  });

  it("is hidden when the file already names the agent", async () => {
    state.detail = detail({ assignable: false });
    renderDetail();
    await screen.findByText(/Thank you for calling Sunrise Benefits\./);
    expect(screen.queryByTestId("speaker-roles")).not.toBeInTheDocument();
  });

  it("shows nothing when the server says assignable but lists no voices", async () => {
    state.detail = detail({ speakers: [] });
    renderDetail();
    await screen.findByText(/Thank you for calling Sunrise Benefits\./);
    expect(screen.queryByTestId("speaker-roles")).not.toBeInTheDocument();
  });

  it("works with a single voice found", async () => {
    state.detail = detail({ speakers: [{ label: "Speaker 1", turns: 2, role: "unknown" }] });
    renderDetail();
    expect(await screen.findByRole("button", { name: "Speaker 1 is the agent" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Speaker 2 is the agent" })).not.toBeInTheDocument();
  });

  it("does not break against a response without voice information", async () => {
    state.detail = detail({ omit: true });
    renderDetail();
    await screen.findByText(/Thank you for calling Sunrise Benefits\./);
    expect(screen.queryByTestId("speaker-roles")).not.toBeInTheDocument();
  });

  it("keeps the buttons usable after a refusal", async () => {
    state.failPost = true;
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Speaker 1 is the agent" }));
    await waitFor(() => expect(state.calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Speaker 1 is the agent" })).toBeEnabled());
  });
});
