/**
 * Live smoke test for Claude on Amazon Bedrock, through the app's real client
 * path (resolveAi* -> buildAiClient -> bedrockAnthropicClient).
 *
 *   AI_INTEGRATIONS_PROVIDER=bedrock \
 *   AI_INTEGRATIONS_BEDROCK_API_KEY=<bedrock api key> \
 *   AI_INTEGRATIONS_BEDROCK_BASE_URL=https://bedrock-runtime.<region>.amazonaws.com/anthropic \
 *   [AI_INTEGRATIONS_MODEL=<id>] pnpm --filter @workspace/scripts run smoke:bedrock
 *
 * Excluded from `tsc` (scripts/tsconfig.json): it imports api-server internals whose
 * ambient types live in that package's own program. Run via tsx.
 * Sends only the literal prompt below — no PHI. Exits non-zero on any failure.
 */
import {
  resolveAiApiKey,
  resolveAiBaseUrl,
  resolveAiModel,
  resolveAiProvider,
  bedrockRoutingIssues,
} from "@workspace/api-server/lib/aiProvider";
import { buildAiClient } from "@workspace/api-server/lib/ai/buildAiClient";

const PROMPT = "Reply with exactly the single word: pong";

function fail(msg: string): never {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const provider = resolveAiProvider();
  if (provider !== "bedrock") {
    fail(`AI_INTEGRATIONS_PROVIDER resolves to "${provider}", expected "bedrock"`);
  }
  if (!resolveAiApiKey(provider)) fail("AI_INTEGRATIONS_BEDROCK_API_KEY is not set");
  const baseURL = resolveAiBaseUrl(provider);
  if (!baseURL) fail("AI_INTEGRATIONS_BEDROCK_BASE_URL is not set");
  const issues = bedrockRoutingIssues();
  if (issues.length > 0) fail(`routing issues:\n  - ${issues.join("\n  - ")}`);

  const client = buildAiClient();
  if (!client) fail("buildAiClient() returned null");
  const model = resolveAiModel(provider);
  console.log(`endpoint ${baseURL}\nmodel    ${model}`);

  const signal = AbortSignal.timeout(30_000);
  const res = await client.chat.completions.create(
    { model, messages: [{ role: "user", content: PROMPT }], max_tokens: 32 },
    { signal },
  );
  const text = res.choices[0]?.message.content?.trim() ?? "";
  if (!text) fail("non-streaming call returned empty text");
  console.log(`PASS  non-stream  served=${res.model} stop=${res.stopReason} text=${JSON.stringify(text)}`);

  const stream = await client.chat.completions.create(
    { model, messages: [{ role: "user", content: PROMPT }], max_tokens: 32, stream: true },
    { signal: AbortSignal.timeout(30_000) },
  );
  let streamed = "";
  let chunks = 0;
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) {
      streamed += delta;
      chunks += 1;
    }
  }
  if (!streamed.trim()) fail("streaming call produced no text");
  console.log(`PASS  stream      chunks=${chunks} text=${JSON.stringify(streamed.trim())}`);
}

main().catch((err: unknown) => fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
