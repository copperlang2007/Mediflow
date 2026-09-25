/**
 * Anthropic Messages client, wearing the Chat Completions shape.
 *
 * WHY THIS EXISTS
 * ---------------
 * agencyBRIDGE's four AI call sites were written against the `openai` SDK and all
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
 * `anthropic-version` header itself. agencyBRIDGE has exactly that — a Bedrock API
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
import { logger } from "../logger";
import { recordAiDegradation } from "../metrics";

/**
 * The Chat Completions surface agencyBRIDGE actually uses — the union of what the
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
  /**
   * Why generation stopped, verbatim from Anthropic (`end_turn`, `max_tokens`,
   * `stop_sequence`, `tool_use`). Exposed because `max_tokens` is otherwise
   * indistinguishable from a complete reply: the response is a well-formed
   * string that simply stops mid-thought. `feature-builder` writes generated
   * files to a git branch, so a truncated file can be committed and reviewed
   * as though it were finished.
   * Optional because the Azure/OpenAI path does not set it.
   * Reported by the AWS review agent on PR #207.
   */
  stopReason?: string;
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
 *
 * We also decline to guess on a host we do not recognise. A private DNS alias,
 * a VPC endpoint, or an empty base URL used to fall through to the
 * `global.anthropic.` branch, silently pinning a routing nobody chose.
 *
 * The same applies to the AWS GovCloud and China partitions. Their hostnames
 * contain `bedrock-runtime`, so they would otherwise inherit the commercial
 * `global.` inference profile -- an id that need not exist there at all. Both
 * are the LAST places to silently guess at routing, so they are excluded and
 * the operator must qualify the id themselves.
 *
 * In every declined case the id passes through untouched and
 * `/admin/health/ai` raises an issue saying so. Reported by the AWS review
 * agent on PR #207.
 */
/**
 * The stream carried only delta types this adapter cannot render as text
 * (thinking, tool input, and anything a future model adds), so the caller
 * would otherwise receive a successful-looking empty answer. Named so the
 * failure is greppable in logs and distinguishable from an AWS-side error.
 */
export class BedrockEmptyStreamError extends Error {
  readonly droppedDeltaTypes: Record<string, number>;

  constructor(droppedDeltaTypes: Record<string, number>) {
    super(
      "bedrock stream produced no text: every delta was of an unrenderable " +
        `type (${Object.keys(droppedDeltaTypes).join(", ")})`,
    );
    this.name = "BedrockEmptyStreamError";
    this.droppedDeltaTypes = droppedDeltaTypes;
  }
}

/**
 * Which documented Bedrock endpoint a base URL names, by HOSTNAME.
 *
 * Exported because two places need the answer and they drifted: the adapter
 * tightened to a hostname match while `/admin/health/ai` kept a substring
 * test, so a private DNS alias containing "bedrock-runtime" made the health
 * check warn about a model/host mismatch for a host the adapter had correctly
 * declined to classify -- a contradiction in the one place an operator goes to
 * reason about routing. One function now answers it for both.
 * Reported by the AWS review agent on PR #207.
 */
export function bedrockHostKind(
  baseURL: string,
): "runtime" | "mantle" | "non-commercial" | "unknown" {
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return "unknown";
  }
  // GovCloud (`*.us-gov-*.amazonaws.com`) and China (`*.amazonaws.com.cn`).
  if (/\.us-gov-/.test(host) || host.endsWith(".amazonaws.com.cn")) {
    return "non-commercial";
  }
  if (/^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/.test(host)) return "mantle";
  if (/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
    return "runtime";
  }
  return "unknown";
}

export function normalizeBedrockModelId(model: string, baseURL = ""): string {
  const id = model.trim();
  if (!id.startsWith("claude-")) return id;

  // Match the HOSTNAME, not any substring of the URL. A substring test meant a
  // private DNS alias that merely contains the string -- `bedrock-runtime.
  // internal.corp`, `foo.bedrock-runtime.example.com` in front of a VPC
  // endpoint -- was read as a commercial AWS host and got `global.anthropic.`
  // prepended, a routing guess made on a name that says nothing about where
  // the traffic goes. ADR 0005 already calls this inference "a guess in a
  // config path, and a thing to keep an eye on"; this narrows it to the two
  // hostname shapes AWS actually documents.
  // Reported by the AWS review agent on PR #207.
  const kind = bedrockHostKind(baseURL);
  if (kind === "mantle") return `anthropic.${id}`;
  if (kind === "runtime") return `global.anthropic.${id}`;
  // A non-commercial partition or an unrecognised host: make no guess, and let
  // /admin/health/ai tell the operator to qualify the id themselves.
  return id;
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

  let emptyDropped = 0;
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    // An empty text block is rejected by the Messages API with a 400, which
    // /ai/chat surfaces to the user as an opaque "AI service unavailable".
    // Empty turns are reachable: the web client persists chat history to
    // localStorage, so closing a tab mid-stream -- before the first delta --
    // leaves an assistant turn with content "" that is replayed on every
    // later request. Skipping it loses nothing that was ever there.
    // Reported by the AWS review agent on PR #207.
    if (m.content.trim() === "") {
      emptyDropped += 1;
      continue;
    }
    rest.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }
  if (emptyDropped > 0) {
    logger.warn(
      { emptyTurns: emptyDropped },
      "bedrock adapter: skipped empty-content turns (Messages rejects empty text blocks)",
    );
    recordAiDegradation("dropped_empty_turns", "bedrock_adapter");
  }

  // Messages must begin with a user turn, so leading assistant turns have to
  // go. This is NOT only a caller bug: /ai/chat accepts assistant turns in
  // `history`, and the web client persists chat history to localStorage and
  // sends the last HISTORY_CAP=50 entries -- a window that can legitimately
  // open on an assistant turn. So a resumed conversation can lose the model's
  // own previous reply, and the user just sees it "forget" what it said.
  // Dropping is still the only option that does not 400, but it must leave a
  // trace: without one, a report of lost context has nothing to point at.
  // Reported by the AWS review agent on PR #207.
  let dropped = 0;
  while (rest.length > 0 && rest[0]!.role === "assistant") {
    rest.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    logger.warn(
      { droppedTurns: dropped },
      "bedrock adapter: dropped leading assistant turns (Messages must open on a user turn)",
    );
    recordAiDegradation("dropped_assistant_turns", "bedrock_adapter");
  }

  // Dropping turns above can leave two same-role turns adjacent, and Messages
  // rejects that with the same 400 the drop existed to avoid -- trading one
  // opaque "AI service unavailable" for another, on exactly the tab-closed-
  // mid-stream history the empty-turn drop was written for:
  // [user, assistant(""), user] becomes [user, user].
  // Joining beats dropping here: both turns are real user text, so a merge
  // loses nothing, where discarding one would silently swallow something the
  // user actually typed.
  // Reported by the AWS review agent on PR #207.
  const coalesced: Anthropic.MessageParam[] = [];
  let merged = 0;
  for (const m of rest) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content as string}\n\n${m.content as string}`;
      merged += 1;
      continue;
    }
    coalesced.push({ ...m });
  }
  if (merged > 0) {
    logger.warn(
      { mergedTurns: merged },
      "bedrock adapter: merged adjacent same-role turns (Messages requires alternation)",
    );
    recordAiDegradation("merged_same_role_turns", "bedrock_adapter");
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: coalesced,
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
    //
    // The discriminator is deliberately narrow. A bare JSON Schema is also
    // accepted here (documented, and tested), and `schema` is a legal property
    // name inside one — so testing only for the presence of a `schema` key
    // would misread such a schema as an envelope and silently drop every other
    // property it declares. An envelope is identified by a `name` STRING
    // beside a `schema` OBJECT, and by the absence of the JSON-Schema keywords
    // a bare schema would carry. Reported by the AWS review agent on PR #207.
    const env = rf.json_schema;
    // A bare schema announces itself with a JSON-Schema keyword. Checking only
    // `type`/`properties` missed every other way to write a valid top-level
    // schema -- `oneOf`, `anyOf`, `allOf`, `$ref`, `enum`, `const` -- so a
    // schema built from those that also happened to carry `name` and `schema`
    // fields would be read as an envelope, and only its inner `schema` subtree
    // would reach the model. The constraints would vanish with no error: the
    // model gets a permissive fragment and returns technically-valid garbage.
    // No caller in the tree can trip this today; it is fixed because a silent
    // wrong answer is the expensive kind, and because this discriminator has
    // already been wrong once.
    // Reported by the AWS review agent on PR #207.
    // Fourth attempt at this discriminator, and the previous three failed the
    // same way: each enumerated one side of the distinction and was wrong
    // about a member it had not thought of. Blocklisting schema keywords
    // missed `required`. Allowlisting envelope keys missed `description`, a
    // documented OpenAI field. Enumerating either side alone will keep losing
    // to whichever list is incomplete, and the failure is always silent -- the
    // wrong half reaches the model and the caller gets structurally-wrong JSON
    // with no error.
    //
    // So require BOTH halves to agree: it is an envelope only if it looks like
    // one (a `name` string wrapping a `schema` object) AND does not look like a
    // schema (no JSON-Schema keyword at the top level). Extra envelope fields
    // no longer matter, so `description` and anything OpenAI adds later is
    // fine; and a bare schema that happens to carry `name`/`schema` still
    // declares itself through its keywords. Both previous bugs are closed by
    // the same condition rather than by a longer list.
    // Reported four times by the AWS review agent on PR #207.
    const SCHEMA_KEYWORDS = [
      "type",
      "properties",
      "required",
      "items",
      "oneOf",
      "anyOf",
      "allOf",
      "not",
      "enum",
      "const",
      "$ref",
      "$schema",
      "$defs",
      "definitions",
      "additionalProperties",
      "patternProperties",
      "prefixItems",
    ];
    const isEnvelope =
      typeof env === "object" &&
      env !== null &&
      typeof (env as { name?: unknown }).name === "string" &&
      typeof (env as { schema?: unknown }).schema === "object" &&
      (env as { schema?: unknown }).schema !== null &&
      !SCHEMA_KEYWORDS.some((k) => k in env);
    const schema = isEnvelope ? (env as { schema: unknown }).schema : env;
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
        stopReason: message.stop_reason ?? undefined,
        choices: [{ message: { content: textOf(message) } }],
      };
    }

    const upstream = await client.messages.create(
      { ...params, stream: true },
      requestOptions,
    );
    return {
      async *[Symbol.asyncIterator]() {
        // Anything that is not text is dropped -- correct today (the SSE routes
        // write every chunk straight to the browser), but if a future model
        // default or prompt change starts producing thinking_delta or
        // input_json_delta blocks, the stream would go silently empty with no
        // error anywhere: /ai/chat appears to hang, the compliance report comes
        // out blank. Summarise ONCE at the end rather than logging per delta --
        // a per-delta line would be thousands of entries for a single response,
        // which is why this can be a warn (above the default level, so it is
        // actually alarmable) instead of a debug nobody sees.
        // Reported by the AWS review agent on PR #207.
        let textChunks = 0;
        const droppedTypes = new Map<string, number>();

        for await (const event of upstream) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") {
            textChunks += 1;
            yield { choices: [{ delta: { content: event.delta.text } }] };
            continue;
          }
          droppedTypes.set(
            event.delta.type,
            (droppedTypes.get(event.delta.type) ?? 0) + 1,
          );
        }

        if (droppedTypes.size > 0) {
          logger.warn(
            {
              droppedDeltaTypes: Object.fromEntries(droppedTypes),
              textChunks,
              // The dangerous case: the caller got NOTHING and no error.
              emptyStream: textChunks === 0,
            },
            "bedrock stream: dropped non-text deltas",
          );
          recordAiDegradation("dropped_non_text_deltas", "bedrock_adapter");
        }
        // A warning alone is not enough when the caller got nothing. Every
        // consumer of this iterator treats "stream ended" as "answer
        // complete": /ai/chat would send `done: true` after zero content
        // frames (a blank answer that looks successful), and the weekly
        // compliance report would persist a zero-length PDF. Both are worse
        // than a failure, because nobody goes looking for a problem that
        // reported success. Throwing here lands in each caller's existing
        // catch: /ai/chat emits its error frame instead of `done`, and the
        // report path skips persistence.
        //
        // Deliberately narrow: only when the model produced deltas we could
        // not render. A genuinely empty response (no deltas at all) is a
        // model outcome, not an adapter defect, and stays a warning.
        if (textChunks === 0 && droppedTypes.size > 0) {
          recordAiDegradation("empty_stream", "bedrock_adapter");
          throw new BedrockEmptyStreamError(
            Object.fromEntries(droppedTypes),
          );
        }
      },
    };
  }

  return {
    chat: { completions: { create: create as ChatCompletionClient["chat"]["completions"]["create"] } },
  };
}
