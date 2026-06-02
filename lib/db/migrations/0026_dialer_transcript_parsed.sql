-- masterBRIDGE dialer integration (Option A, Phase 5) — in-platform
-- transcript parsing + agent-assist (spec §5 row, §6 call.transcript.ready, §8).
--
-- On `call.transcript.ready` MediFlow parses the transcript IN-PLATFORM via
-- its own AI provider (Azure OpenAI in prod — the only BAA-covered path) to
-- produce structured agent-assist output. The structured result is stored on
-- the dial ticket; nothing is ever sent back to the dialer's LLM path (PHI
-- stays inside the BAA boundary).
--
--   * transcript_parsed     jsonb NULL
--                            Structured agent-assist result: concise summary,
--                            suggested disposition, detected compliance/risk
--                            signals, and action items. Shape is owned by the
--                            app-side typed schema in `transcriptParse.ts`
--                            (additive/forward-compatible). NULL until the
--                            ready handler has run a successful parse. Never
--                            contains the MBI.
--
--   * transcript_parsed_at  timestamptz NULL
--                            When the in-platform parse completed. NULL until
--                            then; lets MediFlow distinguish "transcript
--                            delivered but not yet parsed" from "parsed".
--
-- Backwards-compatible: existing rows get NULL for both columns. The raw
-- transcript is NOT stored here — only its hash (existing transcript_hash) and
-- the derived agent-assist result — so the dialer's purge (§6.1) does not
-- orphan any raw PHI on the MediFlow side.

ALTER TABLE "dial_tickets"
  ADD COLUMN IF NOT EXISTS "transcript_parsed" jsonb;
--> statement-breakpoint

ALTER TABLE "dial_tickets"
  ADD COLUMN IF NOT EXISTS "transcript_parsed_at" timestamp with time zone;
--> statement-breakpoint

COMMENT ON COLUMN "dial_tickets"."transcript_parsed" IS
  'Phase 5 agent-assist result (summary, suggested disposition, risk flags, action items) produced in-platform by the MediFlow AI provider on call.transcript.ready. Never sent to the dialer; never contains the MBI.';
--> statement-breakpoint

COMMENT ON COLUMN "dial_tickets"."transcript_parsed_at" IS
  'Timestamp the in-platform transcript parse completed. NULL until parsed.';
