-- Contacts CSV import: street address + city. Additive and nullable, so it is
-- safe on a live table and needs no backfill.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address1 text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city text;
