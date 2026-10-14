import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

test("sends unauthenticated visitors away from the app to sign in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("signs in with a test user (password + authenticator code) and lands on the dashboard", async ({
  page,
}) => {
  // Needs E2E_TEST_EMAIL, E2E_TEST_PASSWORD and E2E_TEST_TOTP_SECRET; see e2e/_helpers/auth.ts.
  await signIn(page);

  await expect(page).toHaveURL(/\/(dashboard)?$/);

  // The dashboard renders a "Dashboard" heading at minimum.
  // TODO: tighten this to a more specific selector once the dashboard has
  //       a stable test id (e.g. data-testid="dashboard-root").
  await expect(
    page.getByRole("heading", { name: /dashboard/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
