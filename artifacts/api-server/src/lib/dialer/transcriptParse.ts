/**
 * In-platform transcript parsing + agent-assist (Option A, Phase 5).
 *
 * On `call.transcript.ready` (spec §6) the dialer pushes the raw transcript to
 * MediFlow and then purges its own copy (§6.1). PHI must stay inside MediFlow's
 * BAA-covered boundary, so the AI parse that turns the transcript into
 * structured agent-assist runs ENTIRELY MediFlow-side and goes through the
 * single AI entry point (`aiProvider.ts` — Azure OpenAI is the only HIPAA-BAA
 * provider in production, §8). The dialer never calls an LLM with PHI, and the
 * parsed result is never sent back to the dialer.
 *
 * This module is transport-free: it takes transcript text + minimal call
 * context and returns a typed `TranscriptParseResult`. The AI client is
 * INJECTABLE (`TranscriptAiClient`) so tests use a mock and no real network
 * call is ever made. The production default is resolved lazily and is gated by
 * `resolveAiProvider()`, which hard-fails in prod unless the provider is Azure.
 */
import OpenAI, { AzureOpenAI } from "openai";
import { z } from "zod/v4";
import { resolveAiProvider } from "../aiProvider";
import { logger } from "../logger";

/** Disposition the model suggests for the call (advisory — agent confirms). */
export const SUGGESTED_DISPOSITION_CATEGORIES = [
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "COMPLIANCE",
  "FOLLOW_UP",
  "UNKNOWN",
] as const;

/** Severity of a detected compliance / risk signal. */
export const RISK_SEVERITIES = ["low", "medium", "high"] as const;

/**
 * Typed agent-assist schema. Kept additive/forward-compatible: unknown extra
 * fields from the model are stripped (we only persist what we validate), and
 * new optional fields can be added without a breaking change. Never contains
 * the MBI or other identifiers — only derived, call-scoped assist content.
 */
export const transcriptParseResultSchema = z.object({
  /** One-paragraph, PHI-minimized summary of the call for the agent. */
  summary: z.string(),
  /** Advisory disposition the agent can confirm against the canonical catalogue. */
  suggestedDisposition: z.object({
    code: z.string().nullable(),
    category: z.enum(SUGGESTED_DISPOSITION_CATEGORIES),
    confidence: z.number().min(0).max(1).nullable(),
  }),
  /** Compliance signals / risk flags detected in the conversation (TCPA, DNC, …). */
  riskFlags: z
    .array(
      z.object({
        kind: z.string(),
        severity: z.enum(RISK_SEVERITIES),
        detail: z.string(),
      }),
    )
    .default([]),
  /** Concrete next steps for the agent. */
  actionItems: z.array(z.string()).default([]),
});

export type TranscriptParseResult = z.infer<typeof transcriptParseResultSchema>;

/** Minimal, NON-PHI call context to steer the parse. No MBI is ever passed. */
export interface TranscriptParseContext {
  dialTicketId?: string | null;
  orgId?: string | null;
  /** Optional dialer-reported disposition code, for cross-checking. */
  reportedDispositionCode?: string | null;
  /** Whether the dialer already redacted the transcript (§6 `redacted`). */
  redacted?: boolean;
}

/**
 * The single chat-completion surface this module needs. Mirrors the OpenAI /
 * AzureOpenAI SDK shape so the real client satisfies it directly, while tests
 * inject a tiny mock. Injecting the client is what keeps the test suite fully
 * offline AND lets us assert that parsing never reaches for the network.
 */
export interface TranscriptAiClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        max_completion_tokens?: number;
        messages: { role: "system" | "user"; content: string }[];
        stream?: false;
        response_format?: { type: "json_object" };
      }): Promise<{
        choices: { message?: { content?: string | null } }[];
      }>;
    };
  };
}

/**
 * Build the production AI client through the HIPAA guard. Mirrors
 * `routes/ai.ts#getOpenAI` so all AI construction stays consistent and gated by
 * `resolveAiProvider()` (throws in prod unless provider=azure). Returns null
 * when AI is not configured — callers degrade gracefully (parse is skipped).
 */
function buildDefaultAiClient(): TranscriptAiClient | null {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) return null;
  // Throws in production if the provider is not the HIPAA-eligible value.
  const provider = resolveAiProvider();
  try {
    if (provider === "azure") {
      const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
      const endpoint =
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
        (resource ? `https://${resource}.openai.azure.com` : undefined);
      if (!endpoint) return null;
      const apiVersion =
        process.env.AI_INTEGRATIONS_AZURE_API_VERSION ?? "2024-02-15-preview";
      const deployment = process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT;
      return new AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion,
        deployment,
      }) as unknown as TranscriptAiClient;
    }
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (!baseURL) return null;
    return new OpenAI({ apiKey, baseURL }) as unknown as TranscriptAiClient;
  } catch {
    return null;
  }
}

const PARSE_SYSTEM_PROMPT = `You are MediFlow's agent-assist analyst for outbound Medicare insurance calls. You receive a single call transcript and return ONLY structured agent-assist JSON — never prose outside the JSON.

Goals:
1. Write a concise, professional summary of what happened on the call (2-4 sentences). Do NOT include the Medicare Beneficiary Identifier (MBI), Social Security numbers, or full payment card numbers in the summary; refer to the beneficiary generically.
2. Suggest a disposition: an advisory code (or null), a category from POSITIVE | NEUTRAL | NEGATIVE | COMPLIANCE | FOLLOW_UP | UNKNOWN, and a confidence in [0,1] (or null).
3. Detect compliance / risk signals (TCPA consent issues, do-not-call requests, calling-hours problems, scope-of-appointment gaps, pressure/misrepresentation, etc.). For each: a short kind, a severity of low | medium | high, and a brief detail.
4. List concrete action items for the agent.

Return JSON shaped exactly as:
{"summary": string, "suggestedDisposition": {"code": string|null, "category": string, "confidence": number|null}, "riskFlags": [{"kind": string, "severity": string, "detail": string}], "actionItems": [string]}`;

const PARSE_MODEL = "gpt-5.4";
const MAX_TRANSCRIPT_CHARS = 24_000;

function buildUserPrompt(
  transcriptText: string,
  ctx: TranscriptParseContext,
): string {
  const clamped =
    transcriptText.length > MAX_TRANSCRIPT_CHARS
      ? `${transcriptText.slice(0, MAX_TRANSCRIPT_CHARS)}\n…[truncated]`
      : transcriptText;
  const hints = [
    ctx.reportedDispositionCode
      ? `Dialer-reported disposition code (for cross-check): ${ctx.reportedDispositionCode}`
      : null,
    typeof ctx.redacted === "boolean"
      ? `Transcript already redacted by the dialer: ${ctx.redacted}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    hints,
    hints ? "" : null,
    "--- CALL TRANSCRIPT ---",
    clamped,
    "--- END TRANSCRIPT ---",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export interface ParseTranscriptOptions {
  /** Inject a mock in tests; defaults to the HIPAA-gated production client. */
  aiClient?: TranscriptAiClient | null;
}

/**
 * Parse a transcript into structured agent-assist. Runs entirely in MediFlow
 * via the injected (or default, BAA-gated) AI client. Returns null when AI is
 * not configured or the model output can't be validated — callers treat a null
 * as "no agent-assist available" and never block the webhook ack on it.
 *
 * IMPORTANT: this function performs NO outbound call to the dialer. The only
 * network egress is to the MediFlow AI provider via the injected client.
 */
export async function parseTranscript(
  transcriptText: string,
  ctx: TranscriptParseContext = {},
  opts: ParseTranscriptOptions = {},
): Promise<TranscriptParseResult | null> {
  const client =
    opts.aiClient !== undefined ? opts.aiClient : buildDefaultAiClient();
  if (!client) {
    logger.info(
      { dialTicketId: ctx.dialTicketId ?? null },
      "Transcript parse: AI provider not configured — skipping agent-assist",
    );
    return null;
  }

  let raw: string;
  try {
    const response = await client.chat.completions.create({
      model: PARSE_MODEL,
      max_completion_tokens: 2048,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PARSE_SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(transcriptText, ctx) },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    logger.error(
      { err, dialTicketId: ctx.dialTicketId ?? null },
      "Transcript parse: AI call failed",
    );
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    logger.warn(
      { dialTicketId: ctx.dialTicketId ?? null },
      "Transcript parse: model returned non-JSON output — discarding",
    );
    return null;
  }

  const parsed = transcriptParseResultSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { dialTicketId: ctx.dialTicketId ?? null, issues: parsed.error.issues },
      "Transcript parse: model output failed schema validation — discarding",
    );
    return null;
  }
  return parsed.data;
}
