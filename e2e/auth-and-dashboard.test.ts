import { expect, test } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.skip(!process.env.E2E_ENABLED, "set E2E_ENABLED=true to run");

test("redirects unauthenticated visitors to Clerk sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("signs in with a Clerk test user and lands on the dashboard", async ({
  page,
}) => {
  // NOTE: if Clerk programmatic sign-in is too brittle in your environment
  // (captcha, bot detection, MFA), swap this for a `storageState`-based
  // pre-authenticated context. See e2e/_helpers/auth.ts for details.
  await signIn(page);

  await expect(page).toHaveURL(/\/(dashboard)?$/);

  // The dashboard renders a "Dashboard" heading at minimum.
  // TODO: tighten this to a more specific selector once the dashboard has
  //       a stable test id (e.g. data-testid="dashboard-root").
  await expect(
    page.getByRole("heading", { name: /dashboard/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
