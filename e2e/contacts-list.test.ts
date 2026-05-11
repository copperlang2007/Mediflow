import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

test("contacts tab on /crm renders a contacts table", async ({ page }) => {
  await signIn(page);

  await page.goto("/crm");
  await expect(page).toHaveURL(/\/crm/);

  // The CRM page exposes a Contacts tab. Click it if not already selected.
  const contactsTab = page.getByRole("tab", { name: /contacts/i });
  if (await contactsTab.count()) {
    await contactsTab.first().click();
  }

  // The contacts table should render even with zero rows. We assert on the
  // presence of a table or grid landmark; an empty-state message is fine too.
  // TODO: once seed data exists, also assert at least one row is visible.
  const tableOrEmpty = page
    .getByRole("table")
    .or(page.getByRole("grid"))
    .or(page.getByText(/no contacts|no results/i));

  await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10_000 });
});
