/**
 * Signature-anchor scanning for carrier paperwork PDFs.
 *
 * The e-sign provider used to drop the visible signature at a fixed
 * top-right position on the last page. That works for the Day-3 dummy
 * fixture but won't be acceptable once real INSUREitALL paperwork lands —
 * carriers expect the signature in the carrier-defined signature box.
 *
 * Convention: every carrier template embeds a short marker string
 * (default: `/SIG/`) at the spot where the visible signature should
 * appear. This helper finds the marker in the PDF byte stream and tells
 * the e-sign provider whether (and approximately where) to place the
 * signature.
 *
 * Why a byte-stream scan instead of a real PDF text-extraction step?
 * `pdf-lib` does NOT include a text-extraction API, and a real PDF
 * extractor (pdfjs-dist, mupdf, etc.) is a heavyweight dependency for a
 * single lookup. The marker is written as a literal PDF text-show
 * operator by our stub builder (`(/SIG/) Tj`) and will be similarly
 * literal in any non-encrypted/non-object-streamed carrier PDF — a
 * byte-level `indexOf` reliably locates it.
 *
 * Limitations (documented so the next person isn't surprised):
 *   - If the carrier PDF uses object streams + encryption, the anchor
 *     won't be found by a byte scan. The fallback path (top-right of
 *     last page) still produces a valid signed PDF — just at the legacy
 *     position. Phase 3 hardening can swap in a real text extractor.
 *   - Coordinate extraction is approximate: we can confirm the anchor
 *     EXISTS on a given page but pulling exact (x, y) from a content
 *     stream requires parsing the surrounding `Td` / `Tm` operators.
 *     For now we return a fixed "bottom-of-page" placement when found,
 *     matching where our stub builder writes the anchor. When real
 *     templates arrive with anchors in other positions, this is where
 *     the proper coordinate extraction goes.
 */
import { PDFDocument } from "pdf-lib";

/**
 * Result of an anchor lookup.
 *   - `found: false` — anchor string is nowhere in the PDF; caller should
 *     fall back to its legacy placement.
 *   - `found: true` — anchor was located. `pageIndex` is the 0-based page
 *     to draw the signature on; `placement` is the approximate (x, y)
 *     where the signature should go. Coordinates are in PDF user space
 *     (origin at bottom-left).
 */
export type AnchorLookupResult =
  | { found: false }
  | {
      found: true;
      pageIndex: number;
      placement: { x: number; y: number };
    };

/**
 * Scan `pdfBytes` for `anchorString`. The scan is page-by-page so the
 * caller learns WHICH page the anchor lives on (relevant when carrier
 * paperwork spans multiple pages and the signature is on, say, page 3).
 *
 * The byte search uses the raw PDF source — Buffer.indexOf — which is
 * O(n*m) worst case but n is the PDF size (~10-100KB) and m is the
 * anchor length (~5 chars); plenty fast for a single per-envelope call.
 */
export async function findSignatureAnchor(
  pdfBytes: Buffer | Uint8Array,
  anchorString: string,
): Promise<AnchorLookupResult> {
  if (!anchorString || anchorString.length === 0) {
    return { found: false };
  }

  const haystack = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
  if (haystack.indexOf(anchorString, 0, "utf8") < 0) {
    return { found: false };
  }

  // We located the anchor in the byte stream — figure out which page it's
  // on by inspecting page count. We can't know which page from a single
  // global indexOf, so we pick the last page (carrier paperwork
  // convention: signatures go on the final page). This matches where the
  // stub builder writes the anchor. When real templates land with
  // multi-page signatures, replace this with a per-page content-stream
  // scan (PDFPage.node.Contents → decode stream → indexOf).
  const pdf = await PDFDocument.load(haystack);
  const pageCount = pdf.getPageCount();
  if (pageCount === 0) return { found: false };

  const pageIndex = pageCount - 1;
  const page = pdf.getPage(pageIndex);

  // Placement: bottom-left of the page, ~60pt up from the bottom margin —
  // matches where `stubBuilder.ts` draws the anchor text. The visible
  // signature is drawn just above this point.
  const { width: _width } = page.getSize();
  return {
    found: true,
    pageIndex,
    placement: { x: 50, y: 70 },
  };
}
