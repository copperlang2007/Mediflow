# Carrier paperwork PDF fixtures

This directory holds the real per-carrier PDF templates dropped in by
INSUREitALL. Each carrier's `CarrierTemplateConfig.templatePath` points at
a file in this dir — when the file is present it is used verbatim; when it
is absent the registry synthesizes a clearly-marked stub PDF on the fly
(`stubBuilder.ts` → `buildStubPdfFromConfig`).

## Dropping in a real carrier PDF

1. Drop the PDF into this directory using the filename in the carrier's
   config `templatePath` (e.g. `aetna-stub.pdf`). Keep the same filename
   even though the contents are no longer a stub — that way no code change
   is needed. Or rename the file AND update `templatePath` in the config;
   either pattern works.
2. Inspect the PDF in Acrobat / `pdftotext` to learn the real AcroForm
   field names (Acrobat's "Prepare Form" view lists them). Update the
   `fields` array in the carrier's `.ts` config so each `name` matches the
   real field name. The `source` column rarely needs to change.
3. Bump `version` from `stub-v0` to something descriptive
   (e.g. `aetna-2026-q2`). Admins use this column to spot agents who
   signed against a stale template.
4. If the real PDF uses a different signature anchor, update
   `signatureAnchor` in the config. The e-sign provider searches the PDF
   text stream for that string and places the visible signature at its
   location.

## Stub mode (today)

No real PDFs are committed here — the directory ships empty except for
this README. The runtime falls through to `buildStubPdfFromConfig`, which
generates a 1-page PDF that:

- Has the carrier name + version in the header
- Has a labelled AcroForm field for every `fields[]` entry
- Has the signature anchor string at the bottom of the last page
- Is loudly stamped `TEMPLATE STUB — NOT THE REAL CARRIER PACKET` so a
  reviewer can't mistake it for the real thing
