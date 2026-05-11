import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

// Minimal valid PDF (1 page, no content). Hand-crafted so we don't need a
// fixtures directory.
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n" +
    "0000000053 00000 n \n0000000100 00000 n \n" +
    "trailer << /Size 4 /Root 1 0 R >>\nstartxref\n160\n%%EOF\n",
);

test("upload a small PDF and see it appear in the list", async ({ page }) => {
  await signIn(page);

  await page.goto("/documents");
  await expect(page).toHaveURL(/\/documents/);

  // The documents page exposes a hidden <input type="file"> wired to an
  // upload button. Playwright's setInputFiles works on hidden inputs.
  const fileInput = page.locator('input[type="file"]').first();

  await fileInput.setInputFiles({
    name: "smoke.pdf",
    mimeType: "application/pdf",
    buffer: TINY_PDF,
  });

  // After upload completes the new file should appear by name in the list.
  await expect(page.getByText("smoke.pdf").first()).toBeVisible({
    timeout: 15_000,
  });

  // Click download and assert we get a successful response.
  // TODO: once the documents UI exposes a stable per-row action menu, target
  //       the row for "smoke.pdf" specifically rather than the first match.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /download/i }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/smoke|\.pdf$/i);
});
