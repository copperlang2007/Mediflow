-- stage2/calendar-branding: per-agency white-label branding.
-- One optional row per org; NULL columns fall back to the agencyBRIDGE default.
-- organizations.logo_url (pre-existing) remains the full-lockup logo.
CREATE TABLE IF NOT EXISTS "org_branding" (
  "org_id" text PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "product_name" text,
  "tagline" text,
  "primary_color" text,
  "accent_color" text,
  "display_font" text,
  "body_font" text,
  "mark_url" text,
  "favicon_url" text,
  "email_from_name" text,
  "updated_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "org_branding_primary_hex" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT "org_branding_accent_hex" CHECK ("accent_color" IS NULL OR "accent_color" ~ '^#[0-9a-f]{6}$')
);
