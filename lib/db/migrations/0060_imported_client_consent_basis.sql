-- Imported-client consent basis for voice calls.
-- org_settings.allow_imported_contact_consent: OFF by default. When an admin
-- turns it on, a contact linked to a GoHighLevel contact and carrying no
-- opt-out of any kind may be called without a documented tcpa_consent_at.
-- call_sessions.consent_basis records which rule allowed (or was evaluated for)
-- each call: 'documented' or 'imported_ghl_recorded_call'.
-- external_contact_links.external_dnd: whether the external system last
-- reported do-not-disturb for that record, even when the sync could not apply
-- it to the contact (weak identity match). NULL (no default, existing rows stay
-- NULL) means unknown / never refreshed: imported-client calling needs an
-- explicit false, so a legacy link is NOT callable until a sync refreshes it.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "allow_imported_contact_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "consent_basis" text;--> statement-breakpoint
ALTER TABLE "external_contact_links" ADD COLUMN IF NOT EXISTS "external_dnd" boolean;
