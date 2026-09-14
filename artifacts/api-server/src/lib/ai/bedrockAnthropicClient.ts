/**
 * Anthropic Messages client, wearing the Chat Completions shape.
 *
 * WHY THIS EXISTS
 * ---------------
 * MediFlow's four AI call sites were written against the `openai` SDK and all
 * call `chat.completions.create({ model, messages, stream })`. When the
 * provider moved to Amazon Bedrock we kept that SDK and pointed its `baseURL`
 * at Bedrock, on the assumption that Bedrock speaks the OpenAI wire format.
 *
 * It does not — not for Claude. AWS's compatibility matrix lists Chat
 * Completions as NOT supported for every Anthropic model. Claude in Amazon
 * Bedrock is served through the *Anthropic Messages API*, with the same
 * request body shape as Anthropic's first-party API, on either of two hosts:
 *
 *   - `https://bedrock-runtime.<region>.amazonaws.com/anthropic`
 *       AWS's recommendation for new applications. Accepts an Amazon Bedrock
 *       API key. Model ids are inference profiles: `global.anthropic.…`,
 *       `us.anthropic.…`.
 *   - `https://bedrock-mantle.<region>.api.aws/anthropic`
 *       Also accepts an Amazon Bedrock API key. Model ids carry a bare
 *       provider prefix: `anthropic.…`.
 *
 * So the deploy could be perfectly configured and every AI feature would still
 * fail on its first request.
 *
 * This module is the adapter. It speaks Messages to Bedrock and Chat
 * Completions to the rest of the codebase, so the call sites — and their
 * tests, which inject fakes against the same shape — do not change.
 *
 * AUTHENTICATION
 * --------------
 * Both AWS and Anthropic document this path: point the standard `Anthropic`
 * client's `base_url` at the `/anthropic` route and pass the Bedrock API key
 * as `api_key`. The SDK sends it as `x-api-key` and adds the required
 * `anthropic-version` header itself. MediFlow has exactly that — a Bedrock API
 * key minted in the operator's own AWS account, covered by their AWS BAA.
 *
 * We send the key in BOTH `x-api-key` and `Authorization: Bearer`, because
 * AWS's two documentation pages disagree and we cannot yet test against the
 * live endpoint:
 *
 *   - *Inference using Anthropic Messages API* — the page for the exact route
 *     we call — shows `-H "x-api-key: $AWS_BEARER_TOKEN_BEDROCK"` against
 *     `bedrock-runtime…/anthropic/v1/messages`, and passes the key as
 *     `api_key` in its Anthropic-SDK example.
 *   - *Use an Amazon Bedrock API key* — the general page — says "include the
 *     following as an authorization header: `Authorization: Bearer …`", and
 *     every example on it uses that form (all against the native
 *     `/model/<id>/converse` route, not `/anthropic`).
 *
 * The route-specific page is the better authority for this route, so
 * `x-api-key` is what we lead with. But the failure mode if it is wrong is
 * total — every AI request and the health ping 401 — while the cost of also
 * sending the Bearer header is a duplicate credential in one TLS request to
 * the same host that already has it. That asymmetry decides it. Drop the
 * redundant header once the live endpoint has told us which one it honours.
 * (Reported as a P1 by the Codex reviewer, reading the general page.)
 *
 * We deliberately do NOT use `@anthropic-ai/bedrock-sdk`: its
 * `AnthropicBedrockMantle` client signs with SigV4 and needs AWS access keys,
 * which this deploy does not carry.
 *
 * WHAT IS DELIBERATELY NOT TRANSLATED
 * -----------------------------------
 * `response_format` is honoured as a *prompt instruction*, not an API
 * guarantee — see `applyResponseFormat()`. Anthropic's platform docs list
 * structured outputs as unsupported on Amazon Bedrock while AWS's own Messages
 * API page lists them as supported; rather than bet a PHI path on resolving
 * that, we use the instruction, which works on both readings. Both call sites
 * that pass `response_format` already parse defensively and degrade when the
 * body is not JSON, which is the only correct posture either way.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * The Chat Completions surface MediFlow actually uses — the union of what the
 * four call sites pass. Deliberately narrow: anything absent here is not
 * translated, so an unsupported option cannot be silently dropped.
 */
export interface ChatCompletionCreateArgs {
  model: string;
  messages: Array<{ role: string; content: string }>;
  /** OpenAI's current name for the output cap. */
  max_completion_tokens?: number;
  /** OpenAI's legacy name for the same thing; `/admin/health/ai` uses it. */
  max_tokens?: number;
  stream?: boolean;
  response_format?: unknown;
}

/** Per-request options both SDKs accept as a second argument. */
export interface ChatCompletionRequestOptions {
  signal?: AbortSignal;
}

export interface ChatCompletionResponse {
  /** The model the provider reports having served. `/admin/health/ai` reads it. */
  model?: string;
  choices: Array<{ message: { content: string | null } }>;
}

export type ChatCompletionStream = AsyncIterable<{
  choices: Array<{ delta?: { content?: string } }>;
}>;

export interface ChatCompletionClient {
  chat: {
    completions: {
      create(
        args: ChatCompletionCreateArgs & { stream: true },
        options?: ChatCompletionRequestOptions,
      ): Promise<ChatCompletionStream>;
      create(
        args: ChatCompletionCreateArgs & { stream?: false },
        options?: ChatCompletionRequestOptions,
      ): Promise<ChatCompletionResponse>;
      create(
        args: ChatCompletionCreateArgs,
        options?: ChatCompletionRequestOptions,
      ): Promise<ChatCompletionResponse | ChatCompletionStream>;
    };
  };
}

/**
 * Anthropic requires an explicit output cap on every request. The Chat
 * Completions sites that omit `max_completion_tokens` (feature-builder) were
 * relying on an OpenAI-side default that has no equivalent here.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Bedrock model ids carry a provider prefix, and WHICH prefix depends on the
 * endpoint:
 *
 *   - bedrock-mantle  → `anthropic.claude-sonnet-5`
 *   - bedrock-runtime → an inference profile, `global.anthropic.claude-sonnet-5`
 *
 * A bare `claude-sonnet-5` — the first-party id, and the natural thing for an
 * operator to paste into `AI_INTEGRATIONS_MODEL` — is rejected by Bedrock with
 * a model-not-found error that says nothing about the prefix. We repair that
 * one case, picking the prefix from the base URL's host.
 *
 * Only a bare `claude-…` id is touched. Anything else passes through — an id
 * that already carries a prefix (`anthropic.…`, `us.anthropic.…`,
 * `global.anthropic.…`) reflects a routing the operator chose deliberately,
 * and a genuinely wrong id should fail as itself rather than as
 * `global.anthropic.<wrong id>`.
 */
export function normalizeBedrockModelId(model: string, baseURL = ""): string {
  const id = model.trim();
  if (!id.startsWith("claude-")) return id;
  return baseURL.includes("bedrock-mantle")
    ? `anthropic.${id}`
    : `global.anthropic.${id}`;
}

/**
 * Split the Chat Completions message list into Anthropic's shape.
 *
 * The one structural difference that matters: in Chat Completions the system
 * prompt is a message; in Messages it is a top-level `system` parameter and
 * `role: "system"` inside `messages` is rejected on most models. Every system
 * message is hoisted, in order, and joined.
 */
function splitMessages(messages: Array<{ role: string; content: string }>): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const rest: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    rest.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }

  // Messages must begin with a user turn. A history that opens on an
  // assistant turn is a caller bug, but a 400 from Bedrock is a terrible way
  // to learn it, so drop the leading assistant turns instead.
  while (rest.length > 0 && rest[0]!.role === "assistant") rest.shift();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

/**
 * Emulate `response_format` in the system prompt.
 *
 * The adapter deliberately does not rely on server-enforced structured
 * outputs (the vendor docs disagree about whether Bedrock has them — see the
 * module header), so this is an instruction and not a contract: callers must
 * still parse defensively. Returning the instruction rather than mutating
 * anything keeps that visible at the call site below.
 */
function applyResponseFormat(
  system: string | undefined,
  responseFormat: unknown,
): string | undefined {
  if (!responseFormat || typeof responseFormat !== "object") return system;
  const rf = responseFormat as { type?: string; json_schema?: unknown };

  let instruction: string | undefined;
  if (rf.type === "json_object") {
    instruction =
      "Respond with a single valid JSON object and nothing else. " +
      "Do not wrap it in markdown code fences and do not add commentary.";
  } else if (rf.type === "json_schema" && rf.json_schema) {
    // OpenAI's `json_schema` value is an ENVELOPE — `{ name, schema, strict? }`
    // — not the schema itself. Serializing the envelope would instruct the
    // model to emit an object with `name` and `schema` keys, so
    // /feature-builder/plan would reject every plan it generated. Unwrap it.
    const env = rf.json_schema as { schema?: unknown };
    const schema =
      env && typeof env === "object" && "schema" in env ? env.schema : env;
    instruction =
      "Respond with a single valid JSON object and nothing else. " +
      "Do not wrap it in markdown code fences and do not add commentary. " +
      "The object must conform to this JSON Schema:\n" +
      JSON.stringify(schema);
  }

  if (!instruction) return system;
  return system ? `${system}\n\n${instruction}` : instruction;
}

/** Concatenate the text blocks of a Messages response. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Build a Chat-Completions-shaped client backed by the Anthropic Messages API
 * on Amazon Bedrock.
 *
 * `baseURL` must be the Bedrock Messages endpoint
 * (`https://bedrock-mantle.<region>.api.aws/anthropic`) and `apiKey` a Bedrock
 * bearer token. Neither is validated here — the caller resolves both through
 * `lib/aiProvider.ts`, which is the single HIPAA choke point.
 */
export function createBedrockAnthropicClient(opts: {
  apiKey: string;
  baseURL: string;
}): ChatCompletionClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    // See AUTHENTICATION in the module header: AWS documents `x-api-key` for
    // this route and `Authorization: Bearer` for Bedrock API keys generally.
    // `apiKey` covers the first; this covers the second. `authToken` would be
    // ignored here -- the SDK gives `apiKey` precedence over it.
    defaultHeaders: { Authorization: `Bearer ${opts.apiKey}` },
  });

  async function create(
    args: ChatCompletionCreateArgs,
    options?: ChatCompletionRequestOptions,
  ): Promise<ChatCompletionResponse | ChatCompletionStream> {
    const split = splitMessages(args.messages);
    const system = applyResponseFormat(split.system, args.response_format);
    // Anthropic rejects an empty `messages` array. A caller that sent only a
    // system message gets a named error rather than an opaque 400 from AWS.
    if (split.messages.length === 0) {
      throw new Error(
        "Anthropic Messages requires at least one user message; " +
          "the request carried only system content.",
      );
    }
    const params = {
      model: normalizeBedrockModelId(args.model, opts.baseURL),
      max_tokens:
        args.max_completion_tokens ?? args.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: split.messages,
      ...(system ? { system } : {}),
    };
    // `signal` is the only per-request option any call site passes, and
    // `/admin/health/ai` depends on it for its 10s ping timeout.
    const requestOptions = options?.signal ? { signal: options.signal } : {};

    if (!args.stream) {
      const message = await client.messages.create(params, requestOptions);
      return {
        model: message.model,
        choices: [{ message: { content: textOf(message) } }],
      };
    }

    const upstream = await client.messages.create(
      { ...params, stream: true },
      requestOptions,
    );
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of upstream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield { choices: [{ delta: { content: event.delta.text } }] };
          }
        }
      },
    };
  }

  return {
    chat: { completions: { create: create as ChatCompletionClient["chat"]["completions"]["create"] } },
  };
}
