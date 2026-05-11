import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

test("create an automation rule with lead_created -> change_contact_status", async ({
  page,
}) => {
  await signIn(page);

  await page.goto("/automations");
  await expect(page).toHaveURL(/\/automations/);

  // Open the "New Rule" dialog.
  await page.getByRole("button", { name: /new rule/i }).click();

  // Give the rule a unique name so we can assert on it later.
  const ruleName = `E2E smoke rule ${Date.now()}`;
  await page.getByLabel(/name/i).first().fill(ruleName);

  // Trigger: lead_created. The dialog uses a Radix select for the trigger.
  // TODO: replace these label-based queries with stable data-testid hooks
  //       once the automation form is instrumented.
  await page.getByLabel(/trigger/i).first().click();
  await page.getByRole("option", { name: /lead.?created/i }).click();

  // Action: change_contact_status -> prospect.
  await page.getByLabel(/action/i).first().click();
  await page
    .getByRole("option", { name: /change.?contact.?status/i })
    .click();

  // Status target = "prospect".
  await page.getByLabel(/status/i).first().click();
  await page.getByRole("option", { name: /prospect/i }).click();

  // Save the rule.
  await page.getByRole("button", { name: /save|create/i }).click();

  // The new rule should appear in the rules list by name.
  await expect(page.getByText(ruleName)).toBeVisible({ timeout: 10_000 });
});
