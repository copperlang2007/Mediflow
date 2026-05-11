import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

const TINY_CSV = Buffer.from(
  "policy_number,member_name,paid_amount,paid_date\n" +
    "POL-0001,Jane Doe,42.50,2026-04-01\n",
);

test("upload a Humana commission statement and land on detail page", async ({
  page,
}) => {
  await signIn(page);

  await page.goto("/commissions");
  await expect(page).toHaveURL(/\/commissions/);

  // Open the upload dialog.
  await page.getByRole("button", { name: /upload statement/i }).click();

  // Carrier: Humana. Radix select.
  await page.getByLabel(/carrier/i).first().click();
  await page.getByRole("option", { name: /humana/i }).click();

  // Date range — pick "Period start" and "Period end" inputs. These are
  // typically <input type="date">; if the UI uses a date-picker popover the
  // selectors below will need to be adapted.
  // TODO: swap to data-testid once the upload dialog is instrumented.
  const startDate = page
    .getByLabel(/period.?start|start.?date|from/i)
    .first();
  const endDate = page.getByLabel(/period.?end|end.?date|to/i).first();
  await startDate.fill("2026-04-01");
  await endDate.fill("2026-04-30");

  // Attach the CSV.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: "humana-2026-04.csv",
    mimeType: "text/csv",
    buffer: TINY_CSV,
  });

  // Submit.
  await page.getByRole("button", { name: /upload|submit|save/i }).click();

  // After upload we expect a redirect to the new statement detail page:
  // /commissions/statements/:id
  await page.waitForURL(/\/commissions\/statements\/[^/]+/, {
    timeout: 20_000,
  });

  // The detail page should show the carrier name.
  await expect(page.getByText(/humana/i).first()).toBeVisible();
});
