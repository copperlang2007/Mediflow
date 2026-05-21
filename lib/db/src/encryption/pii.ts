/**
 * Generic column-level encryption helpers for non-MBI PII (SSN, EIN, etc.).
 *
 * Built directly on top of the same PHI key material used for `medicare_id`:
 *   - PHI_ENCRYPTION_KEY (AES-256-GCM, 32 raw bytes, base64-encoded)
 *   - PHI_HMAC_KEY       (HMAC-SHA256, 32 raw bytes, base64-encoded)
 *
 * The keys live in process env, never in Postgres — exactly the same boot
 * guard as `medicareId.ts`. In production both must be set; in test/dev a
 * deterministic dev-only key is used so the harness still boots.
 *
 * Why a separate module instead of just calling `encryptMedicareId`?
 *  - The normalization rules differ per field type (SSN strips dashes,
 *    MBI keeps dashes-and-uppercases). Forcing one helper across both fields
 *    would either collide on hash output or surprise call-sites.
 *  - SSN/EIN call sites want to think in domain terms — `encryptSsn` /
 *    `encryptEin`, not "encryptPii('ssn', value)".
 *
 * Layout (matches `medicareId.ts` so the same bytea column shape is reused):
 *   bytea = IV (12 bytes) || authTag (16 bytes) || ciphertext
 *
 * The bytea ciphertext is non-deterministic (per-row IV). The HMAC hash is
 * deterministic on the normalized plaintext and is the blind index used
 * for dup detection.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const AES_ALGO = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const HMAC_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const DEV_AES_KEY = Buffer.alloc(AES_KEY_BYTES, 0xab);
const DEV_HMAC_KEY = Buffer.alloc(HMAC_KEY_BYTES, 0xcd);

interface PhiKeys {
  aesKey: Buffer;
  hmacKey: Buffer;
}

let cachedKeys: PhiKeys | null = null;

function decodeKey(envVar: string, raw: string, expectedBytes: number): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${envVar} must be base64-encoded`);
  }
  if (buf.length !== expectedBytes) {
    throw new Error(
      `${envVar} must decode to exactly ${expectedBytes} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

function isNonProdEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development" || env === undefined;
}

function loadKeys(): PhiKeys {
  if (cachedKeys) return cachedKeys;

  const aesRaw = process.env.PHI_ENCRYPTION_KEY;
  const hmacRaw = process.env.PHI_HMAC_KEY;

  if (!aesRaw || !hmacRaw) {
    if (isNonProdEnv()) {
      cachedKeys = { aesKey: DEV_AES_KEY, hmacKey: DEV_HMAC_KEY };
      return cachedKeys;
    }
    const missing = [
      !aesRaw ? "PHI_ENCRYPTION_KEY" : null,
      !hmacRaw ? "PHI_HMAC_KEY" : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Missing required PHI encryption env vars in production: ${missing}`,
    );
  }

  cachedKeys = {
    aesKey: decodeKey("PHI_ENCRYPTION_KEY", aesRaw, AES_KEY_BYTES),
    hmacKey: decodeKey("PHI_HMAC_KEY", hmacRaw, HMAC_KEY_BYTES),
  };
  return cachedKeys;
}

/** For tests only — clears the cached key material. */
export function resetPiiKeyCacheForTests(): void {
  cachedKeys = null;
}

/**
 * Encrypt + HMAC arbitrary PII text. The caller is responsible for
 * normalization (e.g. stripping SSN dashes) BEFORE calling this — that
 * way the hash output is consistent across formatted/unformatted user input.
 */
export function encryptPii(normalizedPlain: string): {
  encrypted: Buffer;
  hash: Buffer;
} {
  const { aesKey, hmacKey } = loadKeys();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalizedPlain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const encrypted = Buffer.concat([iv, authTag, ciphertext]);
  const hash = createHmac("sha256", hmacKey)
    .update(normalizedPlain, "utf8")
    .digest();

  return { encrypted, hash };
}

/** Decrypt a previously-stored PII ciphertext. */
export function decryptPii(encrypted: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(encrypted)
    ? encrypted
    : Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);

  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("encrypted PII payload too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const { aesKey } = loadKeys();
  const decipher = createDecipheriv(AES_ALGO, aesKey, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/** Compute just the HMAC blind index for a normalized plaintext. */
export function hashPii(normalizedPlain: string): Buffer {
  const { hmacKey } = loadKeys();
  return createHmac("sha256", hmacKey).update(normalizedPlain, "utf8").digest();
}

// ---- SSN-specific helpers ---------------------------------------------------

/**
 * Normalize an SSN to digits-only. Accepts "123-45-6789", "123 45 6789",
 * "123456789", etc. Throws if the result is not exactly 9 digits — defensive
 * against bad user input slipping past zod (e.g. via a future direct caller).
 */
export function normalizeSsn(plain: string): string {
  const digits = plain.replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new Error("SSN must have exactly 9 digits after normalization");
  }
  return digits;
}

export function encryptSsn(plain: string): { encrypted: Buffer; hash: Buffer } {
  return encryptPii(normalizeSsn(plain));
}

export function decryptSsn(encrypted: Buffer | Uint8Array): string {
  return decryptPii(encrypted);
}

export function hashSsn(plain: string): Buffer {
  return hashPii(normalizeSsn(plain));
}

// ---- EIN-specific helpers ---------------------------------------------------

/**
 * Normalize an EIN to digits-only. Accepts "12-3456789", "123456789".
 * EINs are 9 digits, same length as SSNs but a different domain (employer
 * identifier, not individual).
 */
export function normalizeEin(plain: string): string {
  const digits = plain.replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new Error("EIN must have exactly 9 digits after normalization");
  }
  return digits;
}

export function encryptEin(plain: string): { encrypted: Buffer; hash: Buffer } {
  return encryptPii(normalizeEin(plain));
}

export function decryptEin(encrypted: Buffer | Uint8Array): string {
  return decryptPii(encrypted);
}
