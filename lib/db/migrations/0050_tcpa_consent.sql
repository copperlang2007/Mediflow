-- TCPA consent capture + org-level enforcement switch. Additive and nullable
-- (the org_settings column has a default), so it is safe on a live table and
-- needs no backfill.
--
-- contacts.tcpa_consent_at      — when the beneficiary gave prior express
--                                 written consent to automated texts.
-- contacts.tcpa_consent_source  — where it was captured (web form URL, recorded
--                                 call id, paper form ref) so it can be produced
--                                 on a complaint or audit.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tcpa_consent_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tcpa_consent_source text;
-- When true (the default), automated SMS (sequences, automation rules) is only
-- sent to contacts with a recorded consent.
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS require_sms_consent boolean NOT NULL DEFAULT true;
-- Where each opt-out came from, so an inbound START lifts only opt-outs that a
-- STOP keyword created ('keyword'), never ones recorded another way (an
-- unsubscribe link, an agent, an integration). Until this release the Twilio
-- STOP webhook was the only writer of opt_outs, so existing sms rows are
-- keyword opt-outs.
ALTER TABLE opt_outs ADD COLUMN IF NOT EXISTS source text;
UPDATE opt_outs SET source = 'keyword' WHERE channel = 'sms' AND source IS NULL;
