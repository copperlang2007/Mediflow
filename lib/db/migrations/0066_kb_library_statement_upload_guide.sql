-- Correct the "Uploading carrier commission statements" library guide: the
-- upload screen now reads the file during the upload, and the file picker only
-- offers CSV/text. Only touches the article if no one has edited it since it was
-- seeded (updated_at = created_at), so a platform admin's own wording is kept.
UPDATE "kb_library_articles"
SET "content" = $kb$WHERE: Commissions > Upload statement button, or Reconciliation > Upload statement. Only Super Admin and Agency Admin can upload, and MFA must be on.

STEPS: 1) Choose the carrier, statement date, period start/end, total (required) and the CSV file. 2) Click Upload & parse. Mediflow reads the file during the upload and tells you how many lines it read. 3) A Parsed statement shows a Reconcile button.

IF THE FILE COULDN'T BE READ: the statement stays Pending and the message says why (for example, no reader for that carrier). Fix the problem, then on the Statements list click Parse (choose file) and pick the file again. Mediflow does not keep uploaded files, so it needs the file each time.

SUPPORTED CARRIERS: Mediflow has readers for Humana (pipe-delimited, no header row), UnitedHealthcare/AARP (CSV, no header), Aetna/CVS (CSV with a header row; needs Member ID and Commission Amount columns) and Anthem/BCBS (CSV, no header). The reader is chosen by the carrier's NAME (containing Humana, UHC, AARP, Aetna, CVS, Anthem, BCBS or Blue Cross). Other carriers (Cigna, Wellcare, etc.) have no reader yet. The file picker offers CSV and text files only; PDF and Excel can't be read yet.

BAD ROWS: For Humana, UHC and Anthem, rows with fewer than 12 columns or entirely blank are silently skipped, and not reported. Unreadable amounts become $0.00. Amounts in parentheses, like (500.00), are read as negative. Types CHGBK, CB, charge, recoup, reverse become chargebacks.$kb$,
    "updated_at" = now()
WHERE "key" = 'mf-commission-statement-upload'
  AND "updated_at" = "created_at";
