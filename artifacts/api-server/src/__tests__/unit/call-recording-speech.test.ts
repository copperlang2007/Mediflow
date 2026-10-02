import { describe, it, expect, afterEach } from "vitest";
import {
  gsUri,
  pollTranscription,
  recognitionConfig,
  resultsToTurns,
  seconds,
  setSpeechHttpForTests,
  speechConfig,
  speechSetup,
  startTranscription,
  type SpeechResult,
} from "../../lib/callScoring/speech";

afterEach(() => setSpeechHttpForTests(null));

const OP = "projects/p1/locations/us/operations/123";

describe("speechSetup", () => {
  it("is off until the provider is chosen and storage is set", () => {
    const s = speechSetup({});
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual(["SPEECH_TO_TEXT_PROVIDER", "PRIVATE_OBJECT_DIR"]);
    expect(speechSetup({ SPEECH_TO_TEXT_PROVIDER: "google" }).missing).toEqual(["PRIVATE_OBJECT_DIR"]);
  });

  it("is ready with Google and a private bucket", () => {
    const s = speechSetup({ SPEECH_TO_TEXT_PROVIDER: "Google", PRIVATE_OBJECT_DIR: "/bucket/private" });
    expect(s.ready).toBe(true);
    expect(s.missing).toEqual([]);
  });
});

describe("speechConfig", () => {
  it("defaults to the US region and chirp_3, and ignores malformed values", () => {
    expect(speechConfig({})).toEqual({ projectId: null, location: "us", model: "chirp_3" });
    expect(speechConfig({ SPEECH_LOCATION: "us/../x", SPEECH_MODEL: "bad model" })).toMatchObject({ location: "us", model: "chirp_3" });
    expect(speechConfig({ GOOGLE_CLOUD_PROJECT: "proj", SPEECH_LOCATION: "us-central1", SPEECH_MODEL: "long" })).toEqual({
      projectId: "proj",
      location: "us-central1",
      model: "long",
    });
  });
});

describe("gsUri", () => {
  it("joins the private dir and the key", () => {
    expect(gsUri("/bucket/private/", "/call-recordings/o/1")).toBe("gs://bucket/private/call-recordings/o/1");
  });
});

describe("recognitionConfig", () => {
  const cfg = { projectId: "p", location: "us", model: "chirp_3" };
  it("splits mono by voice and stereo by channel", () => {
    const mono = recognitionConfig(cfg, "mono") as { features: Record<string, unknown> };
    // Word timestamps would cap chirp_3 batch at 20 minutes of audio.
    expect(mono.features.enableWordTimeOffsets).toBeUndefined();
    expect(mono.features.diarizationConfig).toEqual({ minSpeakerCount: 2, maxSpeakerCount: 2 });
    expect(mono.features.multiChannelMode).toBeUndefined();
    const stereo = recognitionConfig(cfg, "agent_left") as { features: Record<string, unknown> };
    expect(stereo.features.multiChannelMode).toBe("SEPARATE_RECOGNITION_PER_CHANNEL");
    expect(stereo.features.diarizationConfig).toBeUndefined();
  });
});

describe("startTranscription / pollTranscription", () => {
  it("starts a batch job on the regional recognizer with inline output", async () => {
    let seen: { url: string; method: string; data?: unknown } | null = null;
    setSpeechHttpForTests(async (req) => {
      seen = req;
      return { name: OP };
    });
    const name = await startTranscription("gs://b/k", "mono", { projectId: "p1", location: "us", model: "chirp_3" });
    expect(name).toBe(OP);
    expect(seen!.url).toBe("https://us-speech.googleapis.com/v2/projects/p1/locations/us/recognizers/_:batchRecognize");
    expect(seen!.method).toBe("POST");
    expect(seen!.data).toMatchObject({ files: [{ uri: "gs://b/k" }], recognitionOutputConfig: { inlineResponseConfig: {} } });
  });

  it("throws when Google returns no operation", async () => {
    setSpeechHttpForTests(async () => ({}));
    await expect(startTranscription("gs://b/k", "mono")).rejects.toThrow(/operation/);
  });

  it("reports running, done and failed", async () => {
    setSpeechHttpForTests(async () => ({ done: false }));
    expect(await pollTranscription(OP)).toEqual({ state: "running" });

    const results: SpeechResult[] = [{ alternatives: [{ transcript: "hello" }] }];
    setSpeechHttpForTests(async () => ({
      done: true,
      response: { results: { "gs://b/k": { inlineResult: { transcript: { results } }, metadata: { totalBilledDuration: "61.4s" } } } },
    }));
    expect(await pollTranscription(OP)).toEqual({ state: "done", results, durationSeconds: 61 });

    setSpeechHttpForTests(async () => ({ done: true, error: { message: "Permission denied on gs://secret-bucket/path" } }));
    const failed = await pollTranscription(OP);
    expect(failed.state).toBe("failed");
    // Google's message names the bucket; only the kind of failure is kept.
    expect(JSON.stringify(failed)).not.toContain("secret-bucket");

    setSpeechHttpForTests(async () => ({ done: true, response: { results: { "gs://b/k": { error: { message: "Audio decoding failed" } } } } }));
    expect(await pollTranscription(OP)).toMatchObject({ state: "failed", reason: expect.stringMatching(/could not be decoded/) });
  });

  it("refuses a malformed operation name without calling Google", async () => {
    let called = false;
    setSpeechHttpForTests(async () => {
      called = true;
      return {};
    });
    expect(await pollTranscription("https://evil.example/x")).toMatchObject({ state: "failed" });
    expect(called).toBe(false);
  });
});

describe("seconds", () => {
  it("reads Google durations", () => {
    expect(seconds("1.5s")).toBe(1.5);
    expect(seconds("12s")).toBe(12);
    expect(seconds(undefined)).toBeNull();
    expect(seconds("abc")).toBeNull();
  });
});

describe("resultsToTurns", () => {
  const w = (word: string, start: number, end: number, speakerLabel?: string) => ({
    word,
    startOffset: `${start}s`,
    endOffset: `${end}s`,
    ...(speakerLabel ? { speakerLabel } : {}),
  });

  it("labels stereo channels Agent and Client, in time order", () => {
    const results: SpeechResult[] = [
      { channelTag: 2, resultEndOffset: "3.4s", alternatives: [{ transcript: "Hi, I have a question." }] },
      { channelTag: 1, resultEndOffset: "1.5s", alternatives: [{ transcript: "Thanks for calling." }] },
      { channelTag: 1, resultEndOffset: "5s", alternatives: [{ transcript: "Sure, go ahead." }] },
      { channelTag: 1, alternatives: [{ transcript: "  " }] },
    ];
    expect(resultsToTurns(results, "agent_left")).toEqual([
      { speaker: "Agent", text: "Thanks for calling.", start: 0, end: 1.5 },
      { speaker: "Client", text: "Hi, I have a question.", start: 0, end: 3.4 },
      { speaker: "Agent", text: "Sure, go ahead.", start: 1.5, end: 5 },
    ]);
    expect(resultsToTurns(results, "agent_right").map((t) => t.speaker)).toEqual(["Client", "Agent", "Client"]);
  });

  it("labels nobody Agent or Client when stereo results carry no channel tags", () => {
    const results: SpeechResult[] = [
      { resultEndOffset: "2s", alternatives: [{ transcript: "Thanks for calling." }] },
      { resultEndOffset: "4s", alternatives: [{ transcript: "Please stop calling me." }] },
    ];
    for (const layout of ["agent_left", "agent_right"] as const) {
      expect(new Set(resultsToTurns(results, layout).map((t) => t.speaker))).toEqual(new Set(["Speaker"]));
    }
  });

  it("groups mono words by speaker label, never guessing roles", () => {
    const results: SpeechResult[] = [
      {
        alternatives: [
          {
            transcript: "Hello there yes hi",
            words: [w("Hello", 0, 0.4, "1"), w("there", 0.5, 0.8, "1"), w("yes", 1, 1.2, "2"), w("hi", 1.3, 1.5, "2")],
          },
        ],
      },
      { alternatives: [{ transcript: "okay", words: [w("okay", 2, 2.3, "1")] }] },
    ];
    expect(resultsToTurns(results, "mono")).toEqual([
      { speaker: "Speaker 1", text: "Hello there", start: 0, end: 0.8 },
      { speaker: "Speaker 2", text: "yes hi", start: 1, end: 1.5 },
      { speaker: "Speaker 1", text: "okay", start: 2, end: 2.3 },
    ]);
  });

  it("keeps unlabelled mono results as single turns", () => {
    expect(resultsToTurns([{ alternatives: [{ transcript: "just text" }], resultEndOffset: "4s" }], "mono")).toEqual([
      { speaker: "Speaker", text: "just text", start: 0, end: 4 },
    ]);
  });
});
