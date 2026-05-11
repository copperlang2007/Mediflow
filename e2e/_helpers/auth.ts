import type { Page } from "@playwright/test";

/**
 * Best-effort programmatic Clerk sign-in.
 *
 * Clerk's hosted sign-in form occasionally renders bot-protection and
 * additional verification steps; if you encounter those, the most reliable
 * approach is to capture an authenticated `storageState` once and re-use it
 * via `playwright.config.ts`. See the Playwright docs:
 * https://playwright.dev/docs/auth
 *
 * Reads:
 *   - E2E_TEST_EMAIL
 *   - E2E_TEST_PASSWORD
 */
export async function signIn(page: Page): Promise<void> {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "signIn(): set E2E_TEST_EMAIL and E2E_TEST_PASSWORD to log in",
    );
  }

  await page.goto("/");

  // The app's HomeRedirect sends unauthenticated users to /sign-in.
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });

  // Clerk's <SignIn /> component renders an email field first, then password.
  await page.getByLabel(/email/i).fill(email);

  // Clerk's button label varies ("Continue", "Sign in") depending on flow.
  const continueBtn = page.getByRole("button", { name: /continue|sign in/i });
  await continueBtn.first().click();

  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /continue|sign in/i }).first().click();

  // After a successful sign-in we should land on /dashboard (or /).
  await page.waitForURL(/\/(dashboard)?$/, { timeout: 15_000 });
}
