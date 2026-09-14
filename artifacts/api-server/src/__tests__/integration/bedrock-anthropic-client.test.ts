/**
 * The Chat-Completions-to-Anthropic-Messages adapter.
 *
 * This is the layer that decides what MediFlow actually sends to Amazon
 * Bedrock, so it is tested against the wire shape rather than through a call
 * site. Everything asserted here is a difference between the two APIs that
 * would otherwise surface as a 400 from AWS on the first production request:
 * the system prompt is a parameter and not a message, `max_tokens` is
 * mandatory, model ids carry a provider prefix, and structured outputs do not
 * exist and must be emulated in the prompt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const create = vi.fn();
const debugSpy = vi.fn();
const warnSpy = vi.fn();

vi.mock("../../lib/logger", () => ({
  logger: {
    debug: (...a: unknown[]) => debugSpy(...a),
    warn: (...a: unknown[]) => warnSpy(...a),
  },
}));

const ctorOpts = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
    constructor(opts: unknown) {
      ctorOpts(opts);
    }
  },
}));

import {
  BedrockEmptyStreamError,
  createBedrockAnthropicClient,
  normalizeBedrockModelId,
} from "../../lib/ai/bedrockAnthropicClient";
import { aiProviderDegradationTotal } from "../../lib/metrics";

async function degradationCount(
  reason: string,
  site = "bedrock_adapter",
): Promise<number> {
  const m = await aiProviderDegradationTotal.get();
  return (
    m.values.find(
      (v) => v.labels.reason === reason && v.labels.site === site,
    )?.value ?? 0
  );
}

function textReply(text = "ok") {
  return {
    model: "anthropic.claude-sonnet-5",
    content: [{ type: "text", text }],
  };
}

const client = () =>
  createBedrockAnthropicClient({
    apiKey: "test-token",
    baseURL: MANTLE,
  });

const MANTLE = "https://bedrock-mantle.us-east-1.api.aws/anthropic";
const RUNTIME = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";

describe("normalizeBedrockModelId", () => {
  it("prefixes a bare Claude id with anthropic. on bedrock-mantle", () => {
    expect(normalizeBedrockModelId("claude-sonnet-5", MANTLE)).toBe(
      "anthropic.claude-sonnet-5",
    );
  });

  it("prefixes a bare Claude id with an inference profile on bedrock-runtime", () => {
    // The two hosts want different id shapes; AWS's own bedrock-runtime
    // examples use `global.anthropic.…`. Picking one prefix for both is how
    // a correctly configured deploy gets a model-not-found error.
    expect(normalizeBedrockModelId("claude-sonnet-5", RUNTIME)).toBe(
      "global.anthropic.claude-sonnet-5",
    );
  });

  it("leaves an already-prefixed id alone on either host", () => {
    // The operator has chosen a routing (regional / global / CRIS); a
    // second prefix would corrupt it.
    for (const base of [MANTLE, RUNTIME]) {
      expect(normalizeBedrockModelId("anthropic.claude-opus-5", base)).toBe(
        "anthropic.claude-opus-5",
      );
      expect(normalizeBedrockModelId("us.anthropic.claude-sonnet-5", base)).toBe(
        "us.anthropic.claude-sonnet-5",
      );
      expect(
        normalizeBedrockModelId("global.anthropic.claude-sonnet-5", base),
      ).toBe("global.anthropic.claude-sonnet-5");
    }
  });

  it("passes a non-Claude id through unchanged so it fails as itself", () => {
    expect(normalizeBedrockModelId("gpt-5.4", MANTLE)).toBe("gpt-5.4");
  });

  it("declines to guess in the GovCloud and China partitions", () => {
    // Both hostnames contain `bedrock-runtime`, so they would otherwise
    // inherit the commercial `global.` inference profile -- an id that need
    // not exist in those partitions at all. They are also the last places to
    // silently guess at routing.
    expect(
      normalizeBedrockModelId(
        "claude-sonnet-5",
        "https://bedrock-runtime.us-gov-west-1.amazonaws.com/anthropic",
      ),
    ).toBe("claude-sonnet-5");
    expect(
      normalizeBedrockModelId(
        "claude-sonnet-5",
        "https://bedrock-runtime.cn-north-1.amazonaws.com.cn/anthropic",
      ),
    ).toBe("claude-sonnet-5");
  });

  it("declines to guess a prefix on an unrecognised host", () => {
    // A private DNS alias or VPC endpoint used to fall through to the
    // `global.` branch, silently pinning a routing nobody chose. Passing the
    // id through means Bedrock rejects it and /admin/health/ai says why.
    expect(
      normalizeBedrockModelId("claude-sonnet-5", "https://ai.internal.corp/anthropic"),
    ).toBe("claude-sonnet-5");
    expect(normalizeBedrockModelId("claude-sonnet-5", "")).toBe("claude-sonnet-5");
  });
});

describe("bedrock Anthropic adapter — authentication", () => {
  beforeEach(() => {
    ctorOpts.mockReset();
    create.mockReset();
    create.mockResolvedValue(textReply());
  });

  it("sends the Bedrock key in BOTH x-api-key and Authorization: Bearer", () => {
    // AWS's two docs pages disagree: the page for this exact route shows
    // `x-api-key`, the general Bedrock-API-key page says `Authorization:
    // Bearer`. Until the live endpoint settles it, send both -- a wrong guess
    // 401s every AI request and the health ping, while a redundant header
    // costs one duplicated credential inside a TLS request the host already
    // holds the key for.
    createBedrockAnthropicClient({ apiKey: "bedrock-token", baseURL: RUNTIME });

    const opts = ctorOpts.mock.calls[0]![0] as {
      apiKey: string;
      baseURL: string;
      defaultHeaders: Record<string, string>;
    };
    // `apiKey` is what the SDK turns into x-api-key.
    expect(opts.apiKey).toBe("bedrock-token");
    expect(opts.defaultHeaders.Authorization).toBe("Bearer bedrock-token");
    expect(opts.baseURL).toBe(RUNTIME);
  });
});

describe("bedrock Anthropic adapter — request translation", () => {
  beforeEach(() => {
    create.mockReset();
    warnSpy.mockReset();
    create.mockResolvedValue(textReply());
  });

  it("hoists system messages into the top-level system parameter", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: "You are an analyst." },
        { role: "user", content: "hello" },
      ],
    });

    const sent = create.mock.calls[0]![0];
    expect(sent.system).toBe("You are an analyst.");
    // `role: "system"` inside messages is rejected by the Messages API.
    expect(sent.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(sent.max_tokens).toBe(512);
    expect(sent.model).toBe("anthropic.claude-sonnet-5");
  });

  it("preserves assistant history turns in order", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });

    expect(create.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  it("drops leading assistant turns rather than letting AWS 400 — and says so", async () => {
    // Reachable in production, not just a caller bug: /ai/chat accepts
    // assistant turns in history and the web client sends the last 50
    // messages, a window that can open on an assistant turn. The user sees
    // the model "forget" its own reply, so the drop must leave a trace.
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "assistant", content: "stale" },
        { role: "user", content: "real" },
      ],
    });

    expect(create.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "real" },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      { droppedTurns: 1 },
      expect.stringContaining("dropped leading assistant turns"),
    );
  });

  it("skips empty-content turns, which the Messages API rejects outright", async () => {
    // Reachable: the web client persists chat history, so a tab closed
    // mid-stream leaves an assistant turn with content "" replayed forever.
    // Anthropic 400s on an empty text block and /ai/chat shows the user an
    // opaque "AI service unavailable".
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "real question" },
        { role: "assistant", content: "" },
        { role: "user", content: "   " },
        { role: "user", content: "follow up" },
      ],
    });

    // This originally asserted [user, user] -- encoding as correct the very
    // sequence Anthropic rejects, so the test would have defended the bug the
    // drop introduced. The turns are merged instead.
    expect(create.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "real question\n\nfollow up" },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      { emptyTurns: 2 },
      expect.stringContaining("empty-content turns"),
    );
  });

  it("refuses cleanly when every turn is empty", async () => {
    await expect(
      client().chat.completions.create({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "" }],
      }),
    ).rejects.toThrow(/at least one user message/);
    expect(create).not.toHaveBeenCalled();
  });

  it("stays quiet when there is nothing to drop", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("always sends max_tokens, which Anthropic requires", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create.mock.calls[0]![0].max_tokens).toBeGreaterThan(0);
  });

  it("accepts the legacy max_tokens spelling used by /admin/health/ai", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    expect(create.mock.calls[0]![0].max_tokens).toBe(1);
  });

  it("refuses a request carrying only system content, with a named error", async () => {
    // The Messages API rejects an empty `messages` array. `/admin/health/ai`
    // used to ping with a lone system message; a health check that cannot run
    // against the production provider is worse than no health check.
    await expect(
      client().chat.completions.create({
        model: "claude-sonnet-5",
        messages: [{ role: "system", content: "ping" }],
      }),
    ).rejects.toThrow(/at least one user message/);
    expect(create).not.toHaveBeenCalled();
  });

  it("forwards an AbortSignal so the health-check timeout still bites", async () => {
    const controller = new AbortController();
    await client().chat.completions.create(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "ping" }],
      },
      { signal: controller.signal },
    );
    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });
});

describe("bedrock Anthropic adapter — response_format emulation", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue(textReply());
  });

  it("turns json_object into a system instruction", async () => {
    // Bedrock does not support structured outputs. Silently dropping
    // response_format would return prose to a caller that calls JSON.parse().
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "Base prompt." },
        { role: "user", content: "go" },
      ],
      response_format: { type: "json_object" },
    });

    const sent = create.mock.calls[0]![0];
    expect(sent.system).toContain("Base prompt.");
    expect(sent.system).toContain("single valid JSON object");
  });

  it("unwraps the OpenAI json_schema envelope and inlines the inner schema", async () => {
    // OpenAI's `json_schema` value is `{ name, schema }`. Serializing the
    // envelope would tell the model to emit an object with `name` and
    // `schema` keys, so /feature-builder/plan would reject its own output.
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "go" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "FeaturePlan",
          schema: {
            type: "object",
            properties: { branchSlug: { type: "string" } },
          },
        },
      },
    });

    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain('"branchSlug"');
    expect(system).not.toContain('"name":"FeaturePlan"');
  });

  it("does not mistake a bare schema with a `schema` property for an envelope", async () => {
    // `schema` is a legal property name in JSON Schema. Testing only for its
    // presence would treat such a schema AS the envelope and silently drop
    // every other property it declares -- producing a corrupted prompt and a
    // 502 on parse. Latent today; the bare-schema form is documented as
    // supported, so a future caller could hit it.
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "go" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: { onlyField: { type: "string" } },
          schema: { properties: { hijacked: { type: "string" } } },
        },
      },
    });

    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain('"onlyField"');
    expect(system).toContain('"hijacked"');
  });

  it("still unwraps a real envelope that carries extra keys", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "go" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "FeaturePlan",
          strict: true,
          schema: { type: "object", properties: { kept: { type: "string" } } },
        },
      },
    });

    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain('"kept"');
    expect(system).not.toContain('"FeaturePlan"');
  });

  it("inlines a bare schema that is not wrapped in an envelope", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "go" }],
      response_format: {
        type: "json_schema",
        json_schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    expect(create.mock.calls[0]![0].system).toContain('"ok"');
  });

  it("leaves the system prompt untouched when no response_format is given", async () => {
    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "Base prompt." },
        { role: "user", content: "go" },
      ],
    });
    expect(create.mock.calls[0]![0].system).toBe("Base prompt.");
  });
});

describe("bedrock Anthropic adapter — response translation", () => {
  beforeEach(() => {
    create.mockReset();
    warnSpy.mockReset();
  });

  it("returns the Chat Completions non-streaming shape", async () => {
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [
        { type: "text", text: "part one " },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "part two" },
      ],
    });

    const res = await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.choices[0]!.message.content).toBe("part one part two");
    expect(res.model).toBe("anthropic.claude-sonnet-5");
  });

  it("adapts the Messages event stream into Chat Completions deltas", async () => {
    create.mockResolvedValue(
      (async function* () {
        yield { type: "message_start" };
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hel" },
        };
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "lo" },
        };
        // A non-text delta must not be emitted as content — the SSE routes
        // write every delta straight to the browser.
        yield {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "…" },
        };
        yield { type: "message_stop" };
      })(),
    );

    const stream = await client().chat.completions.create({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const chunks: Array<string | undefined> = [];
    for await (const chunk of stream) chunks.push(chunk.choices[0]?.delta?.content);
    // Exactly two chunks: the thinking delta and the lifecycle events must be
    // filtered out, not emitted as empty content. Asserting only the joined
    // text would pass even if every event were forwarded.
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(create.mock.calls[0]![0].stream).toBe(true);
  });

  it("warns once about the non-text deltas it drops, so a silent-empty stream is diagnosable", async () => {
    // Dropping non-text deltas is correct today, but if a future model or
    // prompt change starts producing them the SSE stream would go empty with
    // no error anywhere. The debug line is the only trace that would exist.
    create.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "…" },
        };
      })(),
    );

    const stream = await client().chat.completions.create({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const chunks: unknown[] = [];
    // The caller got no text at all, so the stream must FAIL rather than end:
    // a clean end reads as "answer complete" to every consumer -- /ai/chat
    // would send `done: true` after zero content frames, and the weekly
    // compliance report would persist an empty PDF.
    await expect(async () => {
      for await (const chunk of stream) chunks.push(chunk);
    }).rejects.toThrow(BedrockEmptyStreamError);

    expect(chunks).toEqual([]);
    // One summary line per stream, not one per delta: a per-delta line would
    // be thousands of entries for a single response, which is exactly why the
    // original was a debug nobody would see.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedDeltaTypes: { thinking_delta: 1 },
        textChunks: 0,
        emptyStream: true,
      }),
      expect.stringContaining("non-text deltas"),
    );
  });

  it("says nothing when a stream is all text", async () => {
    // The warn must fire on the exception, not on every stream -- otherwise it
    // is noise and gets filtered, which is how it stops being alarmable.
    create.mockResolvedValue(
      (async function* () {
        yield {
          type: "message_start",
        };
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "all good" },
        };
      })(),
    );

    const stream = await client().chat.completions.create({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of stream) void _;

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("summarises many dropped deltas in one line, and flags a non-empty stream", async () => {
    create.mockResolvedValue(
      (async function* () {
        for (let i = 0; i < 500; i += 1) {
          yield {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "…" },
          };
        }
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        };
        yield {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        };
      })(),
    );

    const stream = await client().chat.completions.create({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of stream) void _;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedDeltaTypes: { thinking_delta: 500, input_json_delta: 1 },
        textChunks: 1,
        // Content did reach the caller, so this is degraded, not silent.
        emptyStream: false,
      }),
      expect.anything(),
    );
  });

  it("merges the same-role pair an empty-turn drop creates, instead of 400ing", async () => {
    // The exact history the empty-turn drop was written for: a tab closed
    // mid-stream leaves assistant(""), which is dropped -- leaving [user,
    // user], which Messages rejects with the same 400 the drop existed to
    // avoid. Both user turns are real text, so merging loses nothing.
    // Reported by the AWS review agent on PR #207.
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [{ type: "text", text: "ok" }],
    });

    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "   " },
        { role: "user", content: "second question" },
      ],
    });

    const sent = create.mock.calls[0]![0].messages;
    expect(sent).toEqual([
      { role: "user", content: "first question\n\nsecond question" },
    ]);
    // Roles must alternate, which is the property Anthropic actually enforces.
    for (let i = 1; i < sent.length; i += 1) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  it("keeps a top-level oneOf schema whole rather than reading it as an envelope", async () => {
    // A bare schema that happens to carry `name` and `schema` fields was
    // misread as an OpenAI envelope, and only the inner subtree reached the
    // model -- constraints gone, no error, technically-valid garbage back.
    // Reported by the AWS review agent on PR #207.
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [{ type: "text", text: "{}" }],
    });

    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          oneOf: [{ type: "object" }],
          name: "x",
          schema: { deprecated: true },
        },
      },
    });

    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain("oneOf");
    // The trap: unwrapping would have sent ONLY this fragment.
    expect(system).not.toMatch(/^\s*\{"deprecated":true\}\s*$/m);
  });

  it("keeps a bare schema whose only keywords are unlisted ones", async () => {
    // The allowlist's reason for existing: `required`/`name`/`schema` names no
    // JSON-Schema keyword a blocklist would have listed, so the blocklist read
    // it as an envelope and dropped `required` silently.
    // Reported by the AWS review agent on PR #207.
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [{ type: "text", text: "{}" }],
    });

    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          required: ["hijacked"],
          name: "x",
          schema: { deprecated: true },
        },
      },
    });

    expect(create.mock.calls[0]![0].system as string).toContain("hijacked");
  });

  it("still unwraps a real OpenAI envelope, which carries only name/schema/strict", async () => {
    // The allowlist must not reject the one shape it exists to recognise --
    // /dev/feature-builder/plan sends exactly this.
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [{ type: "text", text: "{}" }],
    });

    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "plan",
          strict: true,
          schema: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    });

    const system = create.mock.calls[0]![0].system as string;
    // Unwrapped: the inner schema reaches the model, the wrapper does not.
    expect(system).toContain('"properties"');
    expect(system).not.toContain('"plan"');
  });

  it("reports stop_reason so a truncated reply is distinguishable from a finished one", async () => {
    // A max_tokens stop returns well-formed text that simply stops. Without
    // this, feature-builder commits the fragment to a git branch.
    // Reported by the AWS review agent on PR #207.
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "half a fi" }],
    });

    const res = await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect((res as { stopReason?: string }).stopReason).toBe("max_tokens");
  });

  it("counts each degradation, so the ADR follow-ups can be scheduled on rates", async () => {
    // A warn log answers "did this ever happen". It does not answer "is this
    // 0.01% or 5% of calls", which is the only question that decides whether
    // retry-with-repair and client-side history slicing are worth building.
    // Asserting the DELTA, not an absolute, so the test does not depend on
    // what other cases in this file already recorded.
    const before = await degradationCount("dropped_assistant_turns");
    create.mockResolvedValue({
      model: "anthropic.claude-sonnet-5",
      content: [{ type: "text", text: "ok" }],
    });

    await client().chat.completions.create({
      model: "claude-sonnet-5",
      messages: [
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "hi" },
      ],
    });

    expect(await degradationCount("dropped_assistant_turns")).toBe(before + 1);
  });

  it("does not throw on a stream that was simply empty", async () => {
    // The boundary of the empty-stream error: it fires only when the model
    // produced deltas we could not render. A response with no deltas at all
    // is a model outcome (a refusal, a zero-token completion), not an adapter
    // defect -- turning that into a 500 would break callers for a case the
    // adapter handled correctly.
    create.mockResolvedValue((async function* () {})());

    const stream = await client().chat.completions.create({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
