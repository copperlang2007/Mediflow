/**
 * Signature audit-trail certificate page.
 *
 * Phase-2 native-signing flow appends a "certificate of completion" page
 * onto every signed packet — the same page DocuSign / Dropbox Sign generate
 * today. We pre-build the renderer here so when phase 2 swaps out the
 * external e-sig vendor, this certificate is ready to drop in.
 *
 * Today the certificate is NOT appended to outgoing paperwork (Dropbox Sign
 * is the v1 vendor and provides its own audit trail). Once we move to
 * native ESIGN-compliant signing (ESIGN Act §101(g): signer identity,
 * intent, consent, and tamper-evident sealing all need to be captured),
 * this renderer is the place where consent + identity get serialized to
 * paper.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface SignatureCertificateInput {
  /** What the signer agreed to — usually a carrier-form template name + version. */
  documentName: string;
  /** SHA-256 hex of the signed document bytes. Tamper-evident. */
  documentHash: string;
  /** Identifies the signer — full name + email + user id (if applicable). */
  signer: {
    fullName: string;
    email: string;
    userId: string | null;
    npn: string | null;
  };
  /** ISO-8601 timestamps for the consent + signature events. */
  consentAt: string;
  signedAt: string;
  /** Captured IP from the request that produced the signature. */
  ipAddress: string | null;
  userAgent: string | null;
  /** Plain-language consent text the signer accepted. */
  consentText: string;
}

const MARGIN_X = 50;

/**
 * Render a one-page certificate of completion as a fresh `PDFDocument`.
 * The caller is responsible for appending it to the signed paperwork (e.g.
 * via `PDFDocument.copyPages`) — keeping this function self-contained
 * means the renderer is trivially testable.
 */
export async function renderSignatureCertificate(
  input: SignatureCertificateInput,
): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  let y = 740;
  page.drawText("Certificate of Completion", {
    x: MARGIN_X,
    y,
    size: 20,
    font: fontBold,
    color: rgb(0, 0, 0),
  });

  y -= 30;
  page.drawText(`Document: ${input.documentName}`, {
    x: MARGIN_X,
    y,
    size: 11,
    font,
  });

  y -= 18;
  // Hash on its own line so a 64-char SHA-256 fits without wrapping.
  page.drawText("SHA-256:", { x: MARGIN_X, y, size: 10, font });
  page.drawText(input.documentHash, {
    x: MARGIN_X + 60,
    y,
    size: 9,
    font: fontMono,
  });

  y -= 30;
  page.drawText("Signer", { x: MARGIN_X, y, size: 13, font: fontBold });
  y -= 18;
  page.drawText(input.signer.fullName, {
    x: MARGIN_X,
    y,
    size: 11,
    font,
  });
  y -= 14;
  page.drawText(input.signer.email, { x: MARGIN_X, y, size: 10, font });
  if (input.signer.npn) {
    y -= 14;
    page.drawText(`NPN: ${input.signer.npn}`, {
      x: MARGIN_X,
      y,
      size: 10,
      font,
    });
  }
  if (input.signer.userId) {
    y -= 14;
    page.drawText(`User: ${input.signer.userId}`, {
      x: MARGIN_X,
      y,
      size: 9,
      font: fontMono,
    });
  }

  y -= 30;
  page.drawText("Audit Trail", { x: MARGIN_X, y, size: 13, font: fontBold });
  y -= 18;
  page.drawText(`Consent recorded: ${input.consentAt}`, {
    x: MARGIN_X,
    y,
    size: 10,
    font,
  });
  y -= 14;
  page.drawText(`Signature applied: ${input.signedAt}`, {
    x: MARGIN_X,
    y,
    size: 10,
    font,
  });
  y -= 14;
  page.drawText(`IP address: ${input.ipAddress ?? "unknown"}`, {
    x: MARGIN_X,
    y,
    size: 10,
    font,
  });
  y -= 14;
  // User agent can be long — truncate so it fits on one line.
  const ua = (input.userAgent ?? "unknown").slice(0, 90);
  page.drawText(`User agent: ${ua}`, { x: MARGIN_X, y, size: 9, font });

  y -= 30;
  page.drawText("Consent Text", { x: MARGIN_X, y, size: 13, font: fontBold });
  y -= 18;
  // Wrap consent text at a fixed width by splitting on whitespace.
  const wrapped = wrapText(input.consentText, 90);
  for (const line of wrapped) {
    page.drawText(line, { x: MARGIN_X, y, size: 9, font });
    y -= 12;
    if (y < 60) break; // overflow protection — extra consent text is dropped
  }

  return pdf;
}

/** Returns the certificate as a Buffer (saves the doc). */
export async function renderSignatureCertificateBuffer(
  input: SignatureCertificateInput,
): Promise<Buffer> {
  const pdf = await renderSignatureCertificate(input);
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > maxCharsPerLine) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
