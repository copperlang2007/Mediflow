# Automatic carrier-statement intake

Carrier statements dropped into a Google Drive folder are picked up, parsed and
(optionally) reconciled with no one typing the carrier, dates or total.

## How it works

Every 10 minutes the worker lists the watched folder and its subfolders (two
levels deep) and, for each **new** file:

1. **Claims it** in `statement_ingest_files`, keyed on `(source, Drive file id, md5)`.
   A file already seen is skipped; a file *replaced in place* has a new md5 and is
   treated as new, but is held for review (see below).
2. **Identifies it.** Carrier from the folder name, then the filename, using the same
   rules as the parsers (`Humana`, `UHC`/`AARP`, `Aetna`/`CVS`, `Anthem`/`BCBS`),
   or an explicit folder mapping. Period from a month in the filename
   (`2026-09`, `202609`, `09-2026`, `September 2026`), else the most common period
   across the lines. Statement date from the filename, else the file's modified date.
3. **Creates the statement and its lines in one transaction**, after storing the file
   in the private PHI bucket.
4. **Reconciles** (`auto` mode) or **waits for approval** (`hold` mode).

Anything it cannot do safely goes to the review list, with a notification to
agency admins and compliance managers, instead of being guessed:

| Reason shown | Why |
|---|---|
| Could not tell which carrier | no folder/filename match, or more than one carrier matches |
| Unsupported file type | only CSV / pipe-delimited text can be read; PDF and Excel need a parser |
| Could not tell the statement period | no month in the filename and no usable dates in the lines |
| A statement for that carrier and period already exists | duplicate, or a corrected re-issue; never auto-applied |
| No commission lines / could not parse | empty or malformed file |
| Reconciled, but N of M lines did not match a client | more than half unmatched (`auto` mode) |

**No carrier-stated total is recorded.** The files do not carry one, and writing the
sum of the lines would make the variance check always pass. The variance banner
therefore does not apply to automatically ingested statements.

## Setup

1. **Service account.** In the Google Cloud project inside the BAA-covered Workspace,
   create a service account with no roles and a JSON key. Enable the Drive API.
2. **Share the folder** with the service account's email as **Viewer** (read-only).
3. **Secret.** Add the key JSON as the GitHub Secret `STATEMENT_INGEST_GOOGLE_CREDENTIALS`.
   Re-run `scripts/deploy/gcp-bootstrap.sh` once so the Secret Manager placeholder
   `mediflow-statement-ingest-google-credentials` exists; the deploy then mounts it.
   Without the secret the worker falls back to Application Default Credentials, which
   cannot read a user's Drive.
4. **Configure the org** (agency admin, MFA):

   ```
   PUT /api/commissions/ingest/source
   { "folderId": "<Drive folder id>", "mode": "hold",
     "carrierFolderMap": { "Q3 Payments": "<carrier id>" } }
   ```

   The folder id is the last path segment of the folder URL. `carrierFolderMap` is only
   needed for folders or files whose names do not identify the carrier.

Start in `hold` and switch to `auto` once a full cycle has come through cleanly.

## Working the review list

| Endpoint | Use |
|---|---|
| `GET /api/commissions/ingest[?status=held,needs_review,failed]` | source config + files |
| `POST /api/commissions/ingest/check` | poll now |
| `POST /api/commissions/ingest/files/:id/approve` | reconcile a held or flagged statement |
| `POST /api/commissions/ingest/files/:id/retry` | forget a failed / flagged file that created no statement, so the next poll re-reads it (fix the name or the mapping first) |
| `POST /api/commissions/ingest/files/:id/dismiss` | clear a flagged file without posting it |

A poll failure (revoked access, wrong folder id) shows as `lastError` on the source and
is reported to Sentry at most once an hour.

## Adding another transport (SFTP, carrier pull)

Implement `StatementSource` (`list()` and `download()`) in
`artifacts/api-server/src/lib/statementIngest/` and return it from `makeSource` in
`workers/statementIngestPoll.ts`. Dedupe, inference, parse and reconcile are shared.
`statement_ingest_sources.kind` already distinguishes transports.
