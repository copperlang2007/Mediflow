// @vitest-environment jsdom
/**
 * "Listen to the recording": shown only when the call has a stored recording,
 * to reviewers and agents alike; nothing is fetched (so nothing is logged)
 * until the person presses the button; the player has no download control; a
 * refusal or an ended link is explained in plain words and can be retried.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.releasePointerCapture = vi.fn();
// jsdom does not implement media playback.
HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
HTMLMediaElement.prototype.pause = vi.fn();
HTMLMediaElement.prototype.canPlayType = vi.fn((t: string) => (["audio/amr", "audio/wave", "audio/opus"].includes(t) ? "" : "maybe"));

const state = vi.hoisted(() => ({
  listenUrl: "https://storage.example/call-recordings/org/rec?read=1&ttl=600",
  calls: [] as Array<{ url: string; method: string }>,
  detail: null as unknown,
  audio: "ok" as "ok" | "fail",
  contentType: "audio/mpeg",
}));
const LISTEN_URL = state.listenUrl;

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    state.calls.push({ url: String(url), method });
    if (String(url).endsWith("/audio")) {
      if (state.audio === "fail") throw Object.assign(new Error("x"), { status: 404, data: { error: "The audio for this call is no longer in storage." } });
      return { url: state.listenUrl, expiresInSeconds: 600, contentType: state.contentType, durationSeconds: 120 };
    }
    return state.detail;
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CallDetail } from "@/components/call-scoring/CallDetail";

function detail(over: { recordingAvailable?: boolean } = {}) {
  return {
    transcript: {
      id: "t1",
      source: "recording",
      format: "json",
      externalRef: null,
      callDate: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      retainUntil: "2036-09-01T12:00:00.000Z",
      speakerMode: "labelled",
      timing: "recorded",
      filename: null,
      textAvailable: true,
      contact: null,
      contactMatch: "none",
      agent: null,
      recordingAvailable: over.recordingAvailable,
    },
    utterances: [
      { id: 0, startSec: 0, endSec: 4, speaker: "Agent", role: "agent", text: "Thank you for calling Sunrise Benefits." },
      { id: 1, startSec: 5, endSec: 6, speaker: "Customer", role: "client", text: "Okay." },
    ],
    disclaimer: "d",
    score: {
      id: "s1",
      createdAt: "2026-09-01T12:00:00.000Z",
      rubric: { id: "iia-2026", version: "1", name: "IIA", passThreshold: 80 },
      ai: { status: "needs_setup", model: null, error: null },
      speakerMode: "unlabelled",
      auto: { score: 50, compliance: "review", criticalFailures: [], needsReview: [] },
      effective: { score: 50, compliance: "review", criticalFailures: [], needsReview: [], openDnc: 0, meetsStandard: false },
    },
    criteria: [],
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

const audioCalls = () => state.calls.filter((c) => c.url.endsWith("/audio"));
const transcriptLoaded = () => screen.findByText(/Thank you for calling Sunrise Benefits\./);

beforeEach(() => {
  state.calls = [];
  state.audio = "ok";
  state.contentType = "audio/mpeg";
  state.detail = detail({ recordingAvailable: true });
});

describe("listen to the recording", () => {
  it("offers a Listen button, and fetches nothing until it is pressed", async () => {
    renderDetail();
    expect(await screen.findByRole("button", { name: /Listen to the recording/ })).toBeEnabled();
    expect(screen.queryByLabelText("Call recording")).not.toBeInTheDocument();
    expect(audioCalls()).toHaveLength(0);
    expect(screen.getByText(/Each time you listen is recorded in the audit log/)).toBeInTheDocument();
  });

  it("plays the recording from the short-lived link, with no download control", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    const player = await screen.findByLabelText("Call recording");
    expect(player).toHaveAttribute("src", LISTEN_URL);
    expect(player).toHaveAttribute("controlslist", "nodownload");
    expect(audioCalls()).toEqual([{ url: "/api/call-scoring/transcripts/t1/audio", method: "GET" }]);
    expect(screen.queryByRole("button", { name: /Listen to the recording/ })).not.toBeInTheDocument();
  });

  it("is available to people who cannot review too (agents listen to their own calls)", async () => {
    renderDetail(false);
    expect(await screen.findByRole("button", { name: /Listen to the recording/ })).toBeInTheDocument();
  });

  it("is hidden when the call has no stored recording", async () => {
    state.detail = detail({ recordingAvailable: false });
    renderDetail();
    await transcriptLoaded();
    expect(screen.queryByTestId("recording-player")).not.toBeInTheDocument();
  });

  it("is hidden against an older response that does not say", async () => {
    state.detail = detail({});
    renderDetail();
    await transcriptLoaded();
    expect(screen.queryByTestId("recording-player")).not.toBeInTheDocument();
  });

  it("explains a refusal in plain words and lets the person try again", async () => {
    state.audio = "fail";
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The audio for this call is no longer in storage.");
    expect(screen.getByRole("button", { name: /Listen to the recording/ })).toBeEnabled();
    expect(screen.queryByLabelText("Call recording")).not.toBeInTheDocument();
  });

  it("says the format cannot be played (no retry wording) when the browser does not support it", async () => {
    state.contentType = "audio/amr";
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    const player = await screen.findByLabelText("Call recording");
    Object.defineProperty(player, "error", { value: { code: 4 }, configurable: true });
    fireEvent.error(player);
    expect(await screen.findByRole("alert")).toHaveTextContent("This recording is in a format your browser cannot play (for example AMR). Ask your agency admin to open it in another player.");
    expect(screen.queryByText(/link ended/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Listen to the recording/ })).toBeInTheDocument();
  });

  it("treats a code-4 error on a playable type as a load failure, not a format problem", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    const player = await screen.findByLabelText("Call recording");
    Object.defineProperty(player, "error", { value: { code: 4 }, configurable: true });
    fireEvent.error(player);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/);
    expect(alert).toHaveTextContent(/link ended/);
    expect(screen.queryByText(/format your browser cannot play/)).not.toBeInTheDocument();
  });

  it("probes the canonical form of an alias type, so an ended link on audio/wave is not blamed on the format", async () => {
    state.contentType = "audio/wave";
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    const player = await screen.findByLabelText("Call recording");
    Object.defineProperty(player, "error", { value: { code: 4 }, configurable: true });
    fireEvent.error(player);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/);
    expect(alert).toHaveTextContent(/link ended/);
    expect(screen.queryByText(/format your browser cannot play/)).not.toBeInTheDocument();
  });

  it("when the link ends, says so and a new press asks for a fresh link", async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: /Listen to the recording/ }));
    fireEvent.error(await screen.findByLabelText("Call recording"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/link ended/);
    await userEvent.click(screen.getByRole("button", { name: /Listen to the recording/ }));
    await waitFor(() => expect(audioCalls()).toHaveLength(2));
    expect(await screen.findByLabelText("Call recording")).toHaveAttribute("src", LISTEN_URL);
  });
});
