import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";

/**
 * Programmatic sign-in through the app's own sign-in page (Google Cloud
 * Identity Platform, ADR 0006): email + password, then the 6-digit code from
 * the test user's authenticator app, computed here from its TOTP secret.
 *
 * Reads:
 *   - E2E_TEST_EMAIL
 *   - E2E_TEST_PASSWORD
 *   - E2E_TEST_TOTP_SECRET (base32 key shown when the test user set up
 *     two-step verification; required, every account has it)
 */
export async function signIn(page: Page): Promise<void> {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;
  const totpSecret = process.env.E2E_TEST_TOTP_SECRET;

  if (!email || !password || !totpSecret) {
    throw new Error("signIn(): set E2E_TEST_EMAIL, E2E_TEST_PASSWORD and E2E_TEST_TOTP_SECRET to log in");
  }

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await page.getByLabel("Code").fill(totp(totpSecret));
  await page.getByRole("button", { name: /verify and sign in/i }).click();

  // After a successful sign-in we should land on /dashboard (or /).
  await page.waitForURL(/\/(dashboard)?$/, { timeout: 15_000 });
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps compute it. */
export function totp(base32Secret: string, now: number = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/[\s=]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("E2E_TEST_TOTP_SECRET is not base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
