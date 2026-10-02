// @vitest-environment jsdom
/**
 * Recording upload (call scoring phase 2b): says plainly when transcription is
 * not set up; otherwise asks for a signed URL, PUTs the file straight to
 * storage with the signed content type, confirms, and lists status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.releasePointerCapture = vi.fn();

const state = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
  routes: {} as Record<string, (call: { url: string; method: string; body: unknown }) => unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call = { url: String(url), method, body };
    state.calls.push(call);
    const handler = state.routes[`${method} ${String(url).split("?")[0]}`];
    if (!handler) throw Object.assign(new Error("not mocked"), { status: 404, data: { error: "not mocked" } });
    const out = handler(call);
    if (out instanceof Error) throw out;
    return out;
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RecordingUpload } from "@/components/call-scoring/RecordingUpload";
import type { CsConfig } from "@/components/call-scoring/shared";

const puts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let putStatus = 200;

class FakeXhr {
  url = "";
  status = 0;
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    puts.push({ url: this.url, headers: this.headers, body });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    this.status = putStatus;
    queueMicrotask(() => this.onload?.());
  }
}

const config = (supported: boolean, layouts = ["mono", "agent_left", "agent_right"]): CsConfig =>
  ({
    rubrics: [],
    defaultRubricId: "medicare-tpmo",
    ai: { status: "needs_setup", message: "" },
    audio: supported
      ? { supported: true, message: "ok", maxBytes: 1000, acceptedFormats: [".mp3", ".wav"], layouts }
      : { supported: false, message: "Audio transcription is not set up yet." },
    limits: { maxFileBytes: 1, maxImportFiles: 1, maxPasteChars: 1, acceptedFormats: [] },
    canCreate: true,
    canReview: true,
    disclaimer: "",
  }) as CsConfig;

function renderIt(supported: boolean, onOpen = vi.fn(), layouts?: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordingUpload config={config(supported, layouts)} onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return onOpen;
}

beforeEach(() => {
  state.calls = [];
  puts.length = 0;
  putStatus = 200;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  state.routes = {};
  vi.unstubAllGlobals();
});

describe("RecordingUpload", () => {
  it("says transcription is not set up and asks for nothing", () => {
    renderIt(false);
    expect(screen.getByText("Audio transcription is not set up yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recording")).not.toBeInTheDocument();
    expect(state.calls).toHaveLength(0);
  });

  it("uploads straight to storage, confirms, and lists the result", async () => {
    let listed = false;
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({
        recordings: listed
          ? [{ id: "r1", status: "scored", layout: "mono", filename: "call.mp3", sizeBytes: 3, durationSeconds: 60, transcriptId: "t1", error: null, createdAt: "2026-10-01T00:00:00.000Z" }]
          : [],
      }),
      "POST /api/call-scoring/recordings/upload-url": () => ({
        recordingId: "r1",
        uploadUrl: "https://storage.example/signed",
        method: "PUT",
        headers: { "Content-Type": "audio/mpeg" },
      }),
      "POST /api/call-scoring/recordings/r1/uploaded": () => ((listed = true), { recordingId: "r1", status: "queued" }),
    };
    const onOpen = renderIt(true);
    expect(await screen.findByText("No recordings uploaded yet.")).toBeInTheDocument();

    const file = new File(["abc"], "call.mp3", { type: "audio/mpeg" });
    await userEvent.upload(screen.getByLabelText("Recording"), file);
    await userEvent.type(screen.getByLabelText("Call reference (optional)"), "EH-1");
    await userEvent.click(screen.getByRole("button", { name: /upload and score/i }));

    await waitFor(() => expect(state.calls.some((c) => c.url.endsWith("/r1/uploaded"))).toBe(true));
    const start = state.calls.find((c) => c.url === "/api/call-scoring/recordings/upload-url")!;
    expect(start.body).toEqual({ filename: "call.mp3", contentType: "audio/mpeg", sizeBytes: 3, layout: "mono", externalRef: "EH-1" });
    expect(puts).toEqual([{ url: "https://storage.example/signed", headers: { "Content-Type": "audio/mpeg" }, body: file }]);

    await userEvent.click(await screen.findByRole("button", { name: "Open call" }));
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("uses only the layouts advertised by the server", async () => {
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({ recordings: [] }),
      "POST /api/call-scoring/recordings/upload-url": () => ({
        recordingId: "r4",
        uploadUrl: "https://storage.example/signed",
        method: "PUT",
        headers: { "Content-Type": "audio/mpeg" },
      }),
      "POST /api/call-scoring/recordings/r4/uploaded": () => ({ recordingId: "r4", status: "queued" }),
    };
    renderIt(true, vi.fn(), ["agent_right"]);
    await userEvent.click(screen.getByRole("combobox", { name: "Channels" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Stereo, agent on the right");
    await userEvent.keyboard("{Escape}");
    await userEvent.upload(screen.getByLabelText("Recording"), new File(["abc"], "call.mp3", { type: "audio/mpeg" }));
    await userEvent.click(screen.getByRole("button", { name: /upload and score/i }));
    await waitFor(() => expect(state.calls.some((c) => c.url.endsWith("/r4/uploaded"))).toBe(true));
    expect(state.calls.find((c) => c.url === "/api/call-scoring/recordings/upload-url")?.body).toMatchObject({ layout: "agent_right" });
  });

  it("retries only the confirmation when the file is already in storage", async () => {
    let confirms = 0;
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({ recordings: [] }),
      "POST /api/call-scoring/recordings/upload-url": () => ({ recordingId: "r9", uploadUrl: "https://s/x", method: "PUT", headers: { "Content-Type": "audio/mpeg" } }),
      "POST /api/call-scoring/recordings/r9/uploaded": () =>
        ++confirms === 1 ? Object.assign(new Error("x"), { status: 503, data: { error: "Recording storage is not available right now." } }) : { recordingId: "r9", status: "queued" },
    };
    renderIt(true);
    await userEvent.upload(screen.getByLabelText("Recording"), new File(["abc"], "call.mp3", { type: "audio/mpeg" }));
    await userEvent.click(screen.getByRole("button", { name: /upload and score/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not available/);
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(confirms).toBe(2));
    expect(state.calls.filter((c) => c.url.endsWith("/upload-url"))).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  it("sends the chosen checklist", async () => {
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({ recordings: [] }),
      "POST /api/call-scoring/recordings/upload-url": () => ({ recordingId: "r8", uploadUrl: "https://s/x", method: "PUT", headers: { "Content-Type": "audio/mpeg" } }),
      "POST /api/call-scoring/recordings/r8/uploaded": () => ({ recordingId: "r8", status: "queued" }),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cfg = {
      ...config(true),
      rubrics: [
        { id: "medicare-tpmo", name: "Medicare sales call", version: "1", description: "", passThreshold: 80 },
        { id: "general-sales", name: "General sales call", version: "1", description: "", passThreshold: 75 },
      ],
    } as CsConfig;
    render(
      <QueryClientProvider client={client}>
        <RecordingUpload config={cfg} onOpen={vi.fn()} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByLabelText("Checklist"));
    await userEvent.click(await screen.findByRole("option", { name: "General sales call" }));
    await userEvent.upload(screen.getByLabelText("Recording"), new File(["abc"], "call.mp3", { type: "audio/mpeg" }));
    await userEvent.click(screen.getByRole("button", { name: /upload and score/i }));
    await waitFor(() => expect(state.calls.some((c) => c.url.endsWith("/r8/uploaded"))).toBe(true));
    expect((state.calls.find((c) => c.url.endsWith("/upload-url"))!.body as { rubricId?: string }).rubricId).toBe("general-sales");
  });

  it("does not confirm when the upload to storage fails", async () => {
    putStatus = 403;
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({ recordings: [] }),
      "POST /api/call-scoring/recordings/upload-url": () => ({ recordingId: "r2", uploadUrl: "https://s/x", method: "PUT", headers: { "Content-Type": "audio/mpeg" } }),
    };
    renderIt(true);
    await userEvent.upload(screen.getByLabelText("Recording"), new File(["abc"], "call.mp3", { type: "audio/mpeg" }));
    await userEvent.click(screen.getByRole("button", { name: /upload and score/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not finish/);
    expect(state.calls.some((c) => c.url.includes("/uploaded"))).toBe(false);
  });

  it("blocks a file over the limit before uploading", async () => {
    state.routes = { "GET /api/call-scoring/recordings": () => ({ recordings: [] }) };
    renderIt(true);
    await userEvent.upload(screen.getByLabelText("Recording"), new File(["x".repeat(2000)], "big.wav", { type: "audio/wav" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/the limit is/);
    expect(screen.getByRole("button", { name: /upload and score/i })).toBeDisabled();
  });

  it("shows a failed recording's reason", async () => {
    state.routes = {
      "GET /api/call-scoring/recordings": () => ({
        recordings: [{ id: "r3", status: "failed", layout: "mono", filename: "bad.mp3", sizeBytes: 1, durationSeconds: null, transcriptId: null, error: "No speech was found in the recording.", createdAt: "2026-10-01T00:00:00.000Z" }],
      }),
    };
    renderIt(true);
    expect(await screen.findByText("No speech was found in the recording.")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
