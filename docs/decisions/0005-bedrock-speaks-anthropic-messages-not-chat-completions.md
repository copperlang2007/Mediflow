# 5. Claude on Amazon Bedrock is called through the Anthropic Messages API, not an OpenAI-shaped client

## Status

Accepted — 2026-09-14. Implemented in this change; unit- and mutation-tested.
Not yet exercised against the live Bedrock endpoint — the production deploy is
blocked on a separate Secret Manager IAM issue. Promote the "verified in
production" claim only once `/admin/health/ai` returns `ping.ok: true` against
the real account.

## Context

MediFlow's four AI call sites — `routes/ai.ts`, `routes/dev/feature-builder.ts`,
`workers/weeklyComplianceReport.ts`, `lib/dialer/transcriptParse.ts` — were all
written against the `openai` SDK and call
`chat.completions.create({ model, messages, stream })`.

When ADR 0004's production deployment moved the AI provider to Amazon Bedrock
(the only HIPAA-BAA path available to this operator that is not Azure), we kept
the `openai` SDK and pointed its `baseURL` at Bedrock. That rested on an
assumption nobody had checked: that Bedrock serves an OpenAI-compatible Chat
Completions API for Claude.

It does not. AWS's API-compatibility matrix lists Chat Completions as
**unsupported for every Anthropic model**. Claude on Bedrock is served through
the *Anthropic Messages API*. The two differ in ways that are fatal, not
cosmetic:

| | Chat Completions | Anthropic Messages |
|---|---|---|
| System prompt | a message with `role: "system"` | a top-level `system` parameter; `role: "system"` in `messages` is rejected |
| Output cap | `max_completion_tokens`, optional | `max_tokens`, **required** |
| Model id | bare (`gpt-5.4`) | provider-prefixed, and the prefix differs by endpoint host |
| Streaming | `choices[].delta.content` | `content_block_delta` events with typed deltas |
| Structured outputs | `response_format` | contested on Bedrock (see Tradeoffs) |

The practical consequence: a deploy could pass every gate, publish a healthy
Cloud Run revision, and still fail on the first AI request of the first user
session. The error would surface as a 503 from `/ai/chat`, a silently skipped
transcript parse, and an empty weekly compliance report — three different
symptoms of one cause.

A second, smaller problem sat alongside it. Each of the four call sites carried
its own hand-copied forty-line client-construction block. Within a single PR
those copies drifted twice, and each drift was an opportunity for one path to
build a client the HIPAA guard had not gated. In a system that sends full
Medicare profiles to an LLM, "which vendor are we about to talk to" must have
exactly one answer.

## Decision

1. Call Bedrock through `@anthropic-ai/sdk`, configured with the Bedrock
   `/anthropic` base URL and the operator's Amazon Bedrock API key. Both AWS
   and Anthropic document this exact configuration; the SDK sends the key as
   `x-api-key` and adds the required `anthropic-version` header itself.
2. Put an adapter — `lib/ai/bedrockAnthropicClient.ts` — between that SDK and
   the rest of the codebase. It speaks Messages upstream and Chat Completions
   downstream, so no call site and no existing test-injected fake changes.
3. Collapse the four duplicated construction blocks into one
   `lib/ai/buildAiClient.ts`, which is now the only place in the application
   that constructs an AI client.
4. Make the default model provider-aware (`claude-sonnet-5` on bedrock,
   the historical `gpt-5.4` elsewhere) and repair a bare `claude-…` id with the
   provider prefix the configured endpoint host requires.

## Alternatives Considered

**`@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`).** The vendor-blessed
client for Bedrock. Rejected: it authenticates with SigV4 and needs AWS access
keys. This deploy carries a Bedrock API key and no AWS credentials, and adding
long-lived AWS access keys to a PHI system to avoid a 200-line adapter is a
bad trade. Anthropic's own docs explicitly sanction the base-URL + bearer-token
path we took.

**Rewrite the four call sites against the Messages API directly.** Honest, and
tempting. Rejected for now: it would rewrite three SSE streaming paths and two
JSON-parsing paths in the same change that fixes the provider, and it would
invalidate every existing AI test fake at the same moment. The adapter keeps
the blast radius at one new module. It is a seam, not a permanent layer — see
Follow-Up Actions.

**Switch the provider to Azure OpenAI**, which genuinely speaks Chat
Completions. Rejected: the operator has an AWS BAA and a Bedrock key today, and
does not have an Azure OpenAI resource. This would trade a known engineering
problem for an unknown procurement one.

## Reasoning

The bug is a wire-format mismatch, and a wire-format mismatch is exactly what
an adapter is for. Isolating it means the four call sites keep the shape their
tests are written against, the HIPAA guard keeps its single choke point, and
the translation itself becomes testable in isolation — which is where the real
risk lives, because every difference in that table is an AWS 400 that would
otherwise only appear in production.

Consolidating construction was not scope creep; it was the same defect one
level up. The reason nobody noticed the provider assumption was that there was
no single place where "which provider, and how do we talk to it" was written
down. Now there is.

## Tradeoffs

- **`response_format` is an instruction, not a guarantee.** Anthropic's
  platform docs list structured outputs as unsupported on Amazon Bedrock; AWS's
  own Messages API page lists them as supported. Rather than bet a PHI path on
  resolving that contradiction, the adapter emulates `response_format` in the
  system prompt, which is correct under either reading but weaker than a
  server-enforced schema. Both call sites that use it already parse
  defensively and degrade on non-JSON, so the failure mode is a skipped parse,
  not a crash. Worth revisiting once the conflict is settled against the live
  account.
- **The Bedrock credential is sent in two headers.** AWS's page for the
  `/anthropic` Messages route documents `x-api-key`; AWS's general
  "Use an Amazon Bedrock API key" page documents `Authorization: Bearer` (all
  of its examples target the native `/model/<id>/converse` route instead). The
  route-specific page is the better authority, so `x-api-key` leads, but the
  cost of guessing wrong is every AI request and the health ping returning 401,
  against a cost of one duplicated credential inside a TLS request to a host
  that already holds it. Both are sent until the live endpoint settles it; the
  redundant header should then be removed. Raised as a P1 by the Codex
  reviewer, reading the general page.
- **An adapter is a layer.** It will diverge from both APIs over time, and it
  translates only the subset MediFlow uses — deliberately, so an unsupported
  option cannot be silently dropped, but it means a future feature (tool use,
  vision, thinking) needs adapter work before it can be used.
- **The endpoint-aware model prefix is inference.** It repairs a bare
  `claude-…` id by reading the base URL's host. An operator who sets a fully
  qualified id always wins; but the repair itself is a guess about intent, and
  a guess in a config path is a thing to keep an eye on. It is deliberately
  narrow: only the two documented commercial hosts are recognised, and an
  unknown host, a private DNS alias, GovCloud (`us-gov-*`) or China
  (`*.amazonaws.com.cn`) get no guess at all — the id passes through and
  `/admin/health/ai` raises an issue telling the operator to qualify it. A
  regulated partition is the last place to silently pick a routing.

## Master Data Flywheel Impact

Restores the AI event stream rather than creating one. Transcript parses,
agent-assist dispositions, risk flags, and weekly compliance reports are
MediFlow's richest proprietary signal — structured judgments about real
Medicare calls that no competitor can buy. Under the broken provider path that
stream produced **zero rows**: every parse failed at the first request and
`parseTranscript()` degraded to `null` by design, silently. This change is what
turns that capture back on. Until it ships, the flywheel's highest-value input
is disconnected and the gap is invisible in the data.

## New Data Flywheel Impact

None created. One is now worth defining and is listed in Follow-Up Actions:
provider-call outcome telemetry (latency, error class, token usage, model id
served) is currently not captured anywhere, which is why a total provider
failure could sit undetected behind a green deploy.

## Moat Impact

Weakly positive, and worth stating honestly: the adapter is not a moat. Any
competent engineer would write the same 200 lines from the same two doc pages.
The defensible asset is the corpus the AI features produce once they run —
parsed transcripts, disposition accuracy against agent corrections, compliance
flags that a human later confirmed or overturned. This change is a
precondition for that corpus, not an instance of it. Claiming otherwise would
be exactly the manufactured defensibility the charter forbids.

## Security / Compliance Impact

Neutral-to-positive; no change to the HIPAA posture's shape.

- The BAA boundary is unchanged. Bedrock is covered by the operator's AWS BAA;
  PHI does not leave it. The credential is an AWS-issued Bedrock key, not an
  OpenAI credential.
- `assertAiProviderHipaaCompliant()` at bootstrap remains the single
  authoritative fail-fast. `buildAiClient()` returns `null` and never throws,
  preserving the contracts that depend on graceful degradation (the transcript
  webhook must not 5xx; a worker must not die).
- Four construction sites became one, so there is now exactly one place a
  non-BAA provider could be reached — and it is guard-gated and directly
  tested (`build-ai-client.test.ts`).
- No secret is logged, hardcoded, or added. No new outbound destination: the
  base URL was already configured, we are now speaking the right protocol to it.
- `/admin/health/ai` previously pinged with a lone system message, which the
  Messages API rejects. The production health check could not have run against
  the production provider. Fixed.

## Reversibility

Easy. The adapter is additive and provider-scoped: `provider=azure` and
`provider=openai` still construct the same `openai`/`AzureOpenAI` clients they
did before, and reverting is a matter of restoring the four construction blocks
— all of which remain in git history at `9757f93`. No data migration, no schema
change, no infrastructure change. The one-way component is the deleted
duplication, which nobody wants back.

## Evidence

- AWS, *Inference using Anthropic Messages API* — both endpoint hosts, the
  `x-api-key` bearer-token path, and the differing model-id prefixes
  (`global.anthropic.…` on `bedrock-runtime`, `anthropic.…` on
  `bedrock-mantle`). `bedrock-runtime` is AWS's stated recommendation for new
  applications.
- Anthropic, *Claude in Amazon Bedrock* — the model-id table, the
  base-URL + bearer-token configuration for the standard client, and the
  unsupported-feature list.
- `bedrock-anthropic-client.test.ts` (16 cases) and `build-ai-client.test.ts`
  (6 cases): 22 passing. Mutation-tested — seven deliberate defects were
  introduced (drop the system hoist, wrong model prefix, ignore the abort
  signal, emit non-text deltas, forward every stream event, skip the
  missing-key guard, bypass the provider guard) and every one was caught. An
  eighth mutation survived and exposed a redundant branch in
  `normalizeBedrockModelId()`, which was then removed rather than papered over.
- Repo-wide `tsc` clean across all five workspaces.
- Three findings from the first automated review round were confirmed and
  fixed, each with a test that fails without the fix: the `json_schema`
  envelope was serialized whole (Copilot); `/admin/health/ai` left its model
  hint at the OpenAI placeholder, so a correctly configured default bedrock
  deploy failed its own health check (Copilot and Codex, independently); and
  the Render deployment doc still described the Bedrock key as being used by
  the OpenAI SDK (Copilot). The health-check finding is the sharpest: this PR
  claimed to repair that endpoint and had left it broken a second way. A third
  reviewer (the AWS DevOps agent) named the consequence the other two did not:
  a false negative there would have caused an operator following **this ADR's
  own empirical gate** to roll back a healthy deploy. That makes the gate below
  only as trustworthy as the endpoint it reads, which is why the endpoint now
  resolves its model through the same `resolveAiModel()` the application uses
  rather than carrying a second, drifting copy of the default.

## Follow-Up Actions

1. **Verify against the live account.** Once the deploy is unblocked, call
   `/admin/health/ai` and confirm `ping.ok: true` and the reported model id.
   This ADR's Status stays qualified until then.
2. **Resolve the structured-outputs contradiction** against the live endpoint
   and, if AWS is right, replace the prompt emulation with the real parameter.
3. **Add provider-call telemetry** (latency, error class, model served, token
   usage) so a total provider failure cannot again hide behind a green deploy.
   This is the new flywheel named above.
4. **Add a key-required boot assertion.** `assertAiProviderHipaaCompliant()`
   validates the provider *value* only; a deploy with a valid provider and no
   API key starts clean and fails at the first AI request.
5. **Consider retiring the adapter** in favour of native Messages calls at the
   four sites, once the provider is proven in production. The adapter is a
   seam, and seams should be load-bearing only as long as they need to be.
6. **Replace the static long-term Bedrock key** with short-term token
   auto-refresh (`aws-bedrock-token-generator`), which is AWS's own
   recommendation for production and which their policy guidance prefers over
   long-lived keys.
