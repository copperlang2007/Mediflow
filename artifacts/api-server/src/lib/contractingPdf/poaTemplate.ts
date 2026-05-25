/**
 * Phase 1.5 — Power-of-Attorney PDF template.
 *
 * Generates a SINGLE run-wide POA PDF that the agent signs ONCE via the
 * native Mediflow e-sign flow. Authorizing party (the agent) grants the
 * grantee (default "INSUREitALL") limited authority to submit Medicare
 * insurance carrier contracting + appointment applications on the agent's
 * behalf for the duration specified (default 90 days; `POA_DAYS_TO_EXPIRE`
 * env override).
 *
 * THIS IS A PLACEHOLDER TEMPLATE — NOT LAWYER-REVIEWED.
 *
 * Every page carries a bold red watermark ("DRAFT PLACEHOLDER — REPLACE
 * BEFORE PRODUCTION USE") and a footer pointing back to the same caveat.
 * INSUREitALL replaces the PDF body with a counsel-reviewed template
 * before any real agents sign. The watermarks are intentionally
 * impossible-to-miss so a stray demo URL can never be mistaken for the
 * production POA.
 *
 * Implemented with pdf-lib (already a dependency for the legacy
 * `pdfFiller` and the e-sign certificate page). Multi-page text flow is
 * naive (manual wrap + page split); the template is short enough
 * (<2 pages of real text) that the simple flow is fine and we avoid
 * pulling a heavier PDF layout library for a placeholder.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface PoaInput {
  /** Agent's printed name, e.g. "Jane Q. Smith". */
  agentFullName: string;
  /** Agent's National Producer Number; "(not on file)" is acceptable. */
  agentNpn: string | null;
  /** Agent's home address — formatted single-line is fine. */
  agentAddress: string;
  /** State codes the agent is licensed in (informational for the POA body). */
  agentLicenseStates: string[];
  /** Carriers the POA authorizes — INSUREitALL submits contracts to each. */
  carrierNames: string[];
  /** Effective date (today by default). */
  effectiveDate: Date;
  /** Expiry date — effectiveDate + POA_DAYS_TO_EXPIRE (default 90 days). */
  expiryDate: Date;
  /** Grantee — the entity authorized to act on the agent's behalf. */
  granteeName: string;
}

/** Default days the POA stays in force. Override with `POA_DAYS_TO_EXPIRE`. */
export const DEFAULT_POA_DAYS_TO_EXPIRE = 90;
/** Default grantee. Override with `POA_GRANTEE_NAME`. */
export const DEFAULT_POA_GRANTEE_NAME = "INSUREitALL";

/** Read env defaults — exported for tests + the route layer. */
export function readPoaConfig(): {
  daysToExpire: number;
  granteeName: string;
} {
  const raw = process.env.POA_DAYS_TO_EXPIRE;
  let daysToExpire = DEFAULT_POA_DAYS_TO_EXPIRE;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 3650) {
      daysToExpire = parsed;
    }
  }
  const granteeName =
    process.env.POA_GRANTEE_NAME && process.env.POA_GRANTEE_NAME.length > 0
      ? process.env.POA_GRANTEE_NAME
      : DEFAULT_POA_GRANTEE_NAME;
  return { daysToExpire, granteeName };
}

// Layout constants. Tweakable in a single place if INSUREitALL wants a
// different look while still placeholder-watermarked.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 60;
const MARGIN_TOP = 90;
const MARGIN_BOTTOM = 90;
const LINE_HEIGHT = 14;
const BODY_FONT_SIZE = 11;

function formatDate(d: Date): string {
  // YYYY-MM-DD — keep it ISO so the placeholder doesn't pretend at a
  // jurisdiction-specific format.
  return d.toISOString().slice(0, 10);
}

/**
 * Wrap a single paragraph into lines that fit within the body column at
 * `font` + `fontSize`. Splits on whitespace only — good enough for the
 * placeholder; no hyphenation or break-word.
 */
function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    const w = font.widthOfTextAtSize(candidate, fontSize);
    if (w <= maxWidth) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Decorate every page in the PDF with the bold red placeholder banner +
 * the footer caveat. Called once after all body content has been laid out.
 * Watermarking AFTER text means the banner sits on top of body content
 * and stays visible no matter what the text flow did.
 */
async function applyPlaceholderWatermarks(
  pdf: PDFDocument,
  fontBold: PDFFont,
  font: PDFFont,
): Promise<void> {
  const pages = pdf.getPages();
  const bannerText = "DRAFT PLACEHOLDER — REPLACE BEFORE PRODUCTION USE";
  const footerText =
    "This document is a draft template for demo/testing only. " +
    "The final POA must be reviewed by counsel before agents sign.";
  for (const page of pages) {
    const { width, height } = page.getSize();
    // Top-of-page banner — bold red, centered.
    const bannerSize = 14;
    const bannerWidth = fontBold.widthOfTextAtSize(bannerText, bannerSize);
    page.drawText(bannerText, {
      x: Math.max(20, (width - bannerWidth) / 2),
      y: height - 40,
      size: bannerSize,
      font: fontBold,
      color: rgb(0.86, 0.12, 0.12),
    });
    // Light underline so the banner reads as a callout, not body text.
    page.drawLine({
      start: { x: 40, y: height - 50 },
      end: { x: width - 40, y: height - 50 },
      thickness: 1,
      color: rgb(0.86, 0.12, 0.12),
    });
    // Footer disclaimer — wraps onto two lines to stay readable.
    const footerSize = 8;
    const footerLines = wrapText(footerText, font, footerSize, width - 80);
    for (let i = 0; i < footerLines.length; i += 1) {
      page.drawText(footerLines[i], {
        x: 40,
        y: 40 - i * 10,
        size: footerSize,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
  }
}

interface Cursor {
  page: PDFPage;
  y: number;
}

function newPage(pdf: PDFDocument): PDFPage {
  return pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
}

/** Move the cursor to a new page if `y` is below the bottom margin. */
function ensureRoom(pdf: PDFDocument, cursor: Cursor, needed: number): Cursor {
  if (cursor.y - needed < MARGIN_BOTTOM) {
    return { page: newPage(pdf), y: PAGE_HEIGHT - MARGIN_TOP };
  }
  return cursor;
}

function drawHeading(
  pdf: PDFDocument,
  cursor: Cursor,
  text: string,
  fontBold: PDFFont,
): Cursor {
  const next = ensureRoom(pdf, cursor, 24);
  next.page.drawText(text, {
    x: MARGIN_X,
    y: next.y,
    size: 13,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  return { page: next.page, y: next.y - 20 };
}

function drawParagraph(
  pdf: PDFDocument,
  cursor: Cursor,
  text: string,
  font: PDFFont,
): Cursor {
  const maxWidth = PAGE_WIDTH - MARGIN_X * 2;
  const lines = wrapText(text, font, BODY_FONT_SIZE, maxWidth);
  let c = cursor;
  for (const line of lines) {
    c = ensureRoom(pdf, c, LINE_HEIGHT);
    c.page.drawText(line, {
      x: MARGIN_X,
      y: c.y,
      size: BODY_FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
    c = { page: c.page, y: c.y - LINE_HEIGHT };
  }
  return { page: c.page, y: c.y - 6 };
}

function drawBulletList(
  pdf: PDFDocument,
  cursor: Cursor,
  items: string[],
  font: PDFFont,
): Cursor {
  let c = cursor;
  for (const item of items) {
    const maxWidth = PAGE_WIDTH - MARGIN_X * 2 - 14;
    const lines = wrapText(item, font, BODY_FONT_SIZE, maxWidth);
    for (let i = 0; i < lines.length; i += 1) {
      c = ensureRoom(pdf, c, LINE_HEIGHT);
      if (i === 0) {
        c.page.drawText("•", {
          x: MARGIN_X,
          y: c.y,
          size: BODY_FONT_SIZE,
          font,
          color: rgb(0, 0, 0),
        });
      }
      c.page.drawText(lines[i], {
        x: MARGIN_X + 14,
        y: c.y,
        size: BODY_FONT_SIZE,
        font,
        color: rgb(0, 0, 0),
      });
      c = { page: c.page, y: c.y - LINE_HEIGHT };
    }
  }
  return { page: c.page, y: c.y - 6 };
}

/**
 * Generate the POA PDF. Returns a Node Buffer ready to upload to GCS via
 * the existing ObjectStorageService.
 */
export async function generatePoaPdf(input: PoaInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let cursor: Cursor = {
    page: newPage(pdf),
    y: PAGE_HEIGHT - MARGIN_TOP,
  };

  // Title.
  cursor.page.drawText("LIMITED POWER OF ATTORNEY", {
    x: MARGIN_X,
    y: cursor.y,
    size: 18,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  cursor = { page: cursor.page, y: cursor.y - 26 };
  cursor.page.drawText("Carrier Contracting & Appointment Submissions", {
    x: MARGIN_X,
    y: cursor.y,
    size: 12,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  cursor = { page: cursor.page, y: cursor.y - 24 };

  // Parties block.
  cursor = drawHeading(pdf, cursor, "Parties", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    `Principal (the "Agent"): ${input.agentFullName}` +
      (input.agentNpn ? ` (NPN: ${input.agentNpn})` : "") +
      `.`,
    font,
  );
  cursor = drawParagraph(
    pdf,
    cursor,
    `Address: ${input.agentAddress}.`,
    font,
  );
  cursor = drawParagraph(
    pdf,
    cursor,
    `Attorney-in-Fact (the "Grantee"): ${input.granteeName}.`,
    font,
  );

  // Grant of authority.
  cursor = drawHeading(pdf, cursor, "Grant of Authority", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    `The Agent hereby grants ${input.granteeName} a limited Power of Attorney ` +
      "to submit Medicare insurance carrier contracting and appointment " +
      "applications to the carriers listed below on the Agent's behalf. " +
      "This authority is strictly limited to the preparation, signature, " +
      "and submission of carrier paperwork; it does NOT include the " +
      "authority to bind insurance policies, transact insurance business " +
      "with the public, or otherwise act in the Agent's capacity as a " +
      "licensed producer.",
    font,
  );

  // Carriers.
  cursor = drawHeading(pdf, cursor, "Authorized Carriers", fontBold);
  const carrierList =
    input.carrierNames.length > 0
      ? input.carrierNames
      : ["(no carriers selected — POA cannot be executed without at least one)"];
  cursor = drawBulletList(pdf, cursor, carrierList, font);

  // Licensed states.
  if (input.agentLicenseStates.length > 0) {
    cursor = drawHeading(pdf, cursor, "Licensed States", fontBold);
    cursor = drawParagraph(pdf, cursor, input.agentLicenseStates.join(", "), font);
  }

  // Term.
  cursor = drawHeading(pdf, cursor, "Effective Period", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    `This Power of Attorney is effective on ${formatDate(input.effectiveDate)} ` +
      `and expires on ${formatDate(input.expiryDate)} (the "Term"). ` +
      "Any submission initiated by the Grantee within the Term remains valid " +
      "even if completed by the carrier after expiry.",
    font,
  );

  // Revocation.
  cursor = drawHeading(pdf, cursor, "Revocation", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    `The Agent may revoke this Power of Attorney at any time by written ` +
      `notice to ${input.granteeName}. Revocation takes effect upon receipt ` +
      "by the Grantee and does not affect submissions already in flight to " +
      "carrier appointment desks.",
    font,
  );

  // Governing law / venue (intentionally bland — placeholder).
  cursor = drawHeading(pdf, cursor, "Governing Law", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    "This Power of Attorney shall be governed by the laws of the Agent's " +
      "state of residence, and any disputes shall be resolved in the " +
      "competent courts of that jurisdiction.",
    font,
  );

  // Signature block.
  cursor = drawHeading(pdf, cursor, "Signature", fontBold);
  cursor = drawParagraph(
    pdf,
    cursor,
    "The Agent executes this Power of Attorney electronically via the " +
      "Mediflow E-Sign service. The signature, audit trail, and " +
      "certificate of completion appended to this document together " +
      "constitute the Agent's binding execution under the federal ESIGN " +
      "Act (15 U.S.C. §7001 et seq.) and applicable state UETA statutes.",
    font,
  );
  cursor = { page: cursor.page, y: cursor.y - 14 };
  cursor = ensureRoom(pdf, cursor, 60);
  cursor.page.drawText("Principal (Agent):", {
    x: MARGIN_X,
    y: cursor.y,
    size: 10,
    font,
    color: rgb(0, 0, 0),
  });
  cursor = { page: cursor.page, y: cursor.y - 18 };
  cursor.page.drawText(input.agentFullName, {
    x: MARGIN_X,
    y: cursor.y,
    size: 12,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  cursor = { page: cursor.page, y: cursor.y - 14 };
  cursor.page.drawText(
    `Effective date: ${formatDate(input.effectiveDate)} — Expiry: ${formatDate(input.expiryDate)}`,
    {
      x: MARGIN_X,
      y: cursor.y,
      size: 9,
      font,
      color: rgb(0.3, 0.3, 0.3),
    },
  );

  // Apply watermarks to every page after the body has been laid out.
  await applyPlaceholderWatermarks(pdf, fontBold, font);

  // useObjectStreams: false leaves the page-content stream uncompressed
  // text-as-bytes (the certificate page uses the same trick — see
  // signatureCertificate.ts). That makes the watermark assertions
  // verifiable via a substring search in tests, and keeps the file size
  // comparable to a normal placeholder PDF.
  const bytes = await pdf.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}
