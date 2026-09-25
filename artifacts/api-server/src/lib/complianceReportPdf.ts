/**
 * Compliance report PDF builder.
 *
 * Converts the AI-generated Markdown compliance report into a styled PDF
 * using pdfkit. Handles headings (## / ###), bullet points (- / *),
 * horizontal rules (---), and plain paragraphs.
 */

import PDFDocument from "pdfkit";

const NAVY = "#1a365d";
const BLUE = "#2b4c7e";
const TEXT = "#111111";
const MUTED = "#555555";
const LIGHT_GREY = "#f5f5f5";

/**
 * Convert a markdown-formatted compliance report string to a PDF Buffer.
 */
export function buildComplianceReportPdf(
  markdownReport: string,
  reportTitle: string,
  dateStr: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header band ─────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 72).fill(NAVY);
    doc
      .fillColor("#ffffff")
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(reportTitle, 50, 20);
    doc
      .fontSize(9)
      .font("Helvetica")
      .text(
        `Generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC   |   Report Date: ${dateStr}`,
        50,
        50,
      );
    doc.fillColor(TEXT);
    doc.y = 90;

    // ── Parse and render lines ───────────────────────────────────────
    const lines = markdownReport.split("\n");

    for (const raw of lines) {
      const line = raw.trimEnd();

      if (doc.y > doc.page.height - 80) {
        doc.addPage();
        doc.y = 60;
      }

      // H2
      if (line.startsWith("## ")) {
        doc.moveDown(0.5);
        const heading = line.replace(/^## /, "").replace(/\*\*/g, "");
        const y = doc.y;
        doc.rect(50, y, doc.page.width - 100, 20).fill(BLUE);
        doc
          .fillColor("#ffffff")
          .fontSize(10)
          .font("Helvetica-Bold")
          .text(heading, 56, y + 5, { lineBreak: false });
        doc.fillColor(TEXT);
        doc.y = y + 26;
        continue;
      }

      // H3
      if (line.startsWith("### ")) {
        doc.moveDown(0.3);
        const heading = line.replace(/^### /, "").replace(/\*\*/g, "");
        doc
          .fillColor(NAVY)
          .fontSize(10)
          .font("Helvetica-Bold")
          .text(heading, 50)
          .fillColor(TEXT);
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(line)) {
        doc.moveDown(0.3);
        doc
          .moveTo(50, doc.y)
          .lineTo(doc.page.width - 50, doc.y)
          .strokeColor("#cccccc")
          .stroke();
        doc.moveDown(0.3);
        continue;
      }

      // Bullet: - or *
      if (/^[\-\*] /.test(line)) {
        const text = line.replace(/^[\-\*] /, "").replace(/\*\*/g, "");
        doc
          .fontSize(9)
          .font("Helvetica")
          .fillColor(TEXT)
          .text(`• ${text}`, 60, doc.y, { width: doc.page.width - 120 });
        continue;
      }

      // Numbered list
      if (/^\d+\. /.test(line)) {
        const text = line.replace(/^\d+\. /, "").replace(/\*\*/g, "");
        const num = line.match(/^(\d+)\./)?.[1] ?? "";
        doc
          .fontSize(9)
          .font("Helvetica")
          .fillColor(TEXT)
          .text(`${num}. ${text}`, 60, doc.y, { width: doc.page.width - 120 });
        continue;
      }

      // Empty line → small gap
      if (line.trim() === "") {
        doc.moveDown(0.25);
        continue;
      }

      // Bold inline (**text**)
      const cleaned = line.replace(/\*\*/g, "");

      // Plain paragraph
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor(TEXT)
        .text(cleaned, 50, doc.y, { width: doc.page.width - 100 });
    }

    // ── Footer on all pages ──────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .font("Helvetica")
        .text(
          `agencyBRIDGE Compliance Intelligence Report — Confidential   |   Page ${i + 1} of ${range.count}`,
          50,
          doc.page.height - 35,
          { align: "center", width: doc.page.width - 100 },
        );
    }

    doc.end();
  });
}
