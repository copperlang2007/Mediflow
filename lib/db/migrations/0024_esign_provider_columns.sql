-- Provider-pluggability columns on esign_envelopes.
--
-- Adds two columns so a non-native provider (DocuSign initially) can
-- coexist with the in-process MediflowESignProvider behind the
-- `ESignProvider` interface:
--
--   - provider              text NOT NULL DEFAULT 'mediflow'
--                            Names the provider that created the envelope.
--                            'mediflow' covers all rows that pre-date this
--                            migration. New rows from a non-native provider
--                            will write 'docusign' (or future provider names).
--                            String-enum + app-side validator — no DB
--                            constraint so adding a provider is one PR.
--
--   - external_envelope_id  text NULL
--                            Provider-side identifier (e.g. DocuSign
--                            envelopeId). Used to correlate inbound
--                            webhook events with our internal envelope row,
--                            and to make outbound provider API calls
--                            (createRecipientView, get-signed-pdf, void).
--                            Always NULL for provider='mediflow' — the
--                            native flow has no external identity.
--
-- Backwards-compatible: every existing row gets provider='mediflow' (the
-- default) and external_envelope_id=NULL. Code paths that don't yet read
-- these columns continue to work — readers added in follow-up PRs (the
-- DocuSign provider + webhook handler).
--
-- An index on (provider, external_envelope_id) accelerates the webhook
-- lookup: "given DocuSign envelopeId X, find our row". The composite
-- form keeps the index narrow (provider='docusign' rows only) without
-- needing a partial-index WHERE clause.

ALTER TABLE "esign_envelopes"
  ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'mediflow';
--> statement-breakpoint

ALTER TABLE "esign_envelopes"
  ADD COLUMN IF NOT EXISTS "external_envelope_id" text;
--> statement-breakpoint

-- Webhook-lookup index. Partial (only non-null external ids) since the
-- native provider never populates external_envelope_id — no point
-- indexing 100% NULL rows.
CREATE INDEX IF NOT EXISTS "esign_envelopes_provider_external_idx"
  ON "esign_envelopes" ("provider", "external_envelope_id")
  WHERE "external_envelope_id" IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN "esign_envelopes"."provider" IS
  'String-enum validated by the app-side ESignProvider factory. Allowed values: mediflow (in-process native), docusign (managed). New providers introduced via app-side updates only — no schema change required.';
--> statement-breakpoint

COMMENT ON COLUMN "esign_envelopes"."external_envelope_id" IS
  'Provider-side identifier. NULL for provider=mediflow. Populated by external providers (DocuSign envelopeId) so inbound webhook events can be correlated to our row, and so outbound provider API calls (createRecipientView, void, get-signed-pdf) can target the right object.';
