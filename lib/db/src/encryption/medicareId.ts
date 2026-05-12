/**
 * Column-level encryption helpers for `contacts.medicare_id` (HIPAA-2).
 *
 * `medicare_id` is a Medicare Beneficiary Identifier (MBI) — direct PHI.
 * Disk-level encryption covers most threats, but column-level encryption
 * adds defense-in-depth against pg_dump exfiltration, backup leaks, and
 * DBA snooping.
 *
 * Storage shape on `contacts`:
 *   - `medicare_id_encrypted` bytea — AES-256-GCM ciphertext with per-row
 *     IV + auth tag; not deterministic.
 *   - `medicare_id_hash` bytea — HMAC-SHA256 of the normalized plaintext;
 *     deterministic, used as the lookup key for exact-match search and
 *     commission reconcile.
 *
 * The encryption keys live in the application's environment, never in
 * Postgres — so backfill and rotation are pure application work.
 *
 *   - `PHI_ENCRYPTION_KEY` (base64-encoded 32 raw bytes) — AES-256-GCM key
 *   - `PHI_HMAC_KEY`       (base64-encoded 32 raw bytes) — HMAC-SHA256 key
 *
 * In production (NODE_ENV not in {"test","development"}) both keys MUST be
 * present at first use, or the helper throws. In test/dev we fall back to
 * a deterministic dev-only key so the suite + local stack still boot;
 * THIS IS NOT SAFE for any environment that holds real PHI.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const AES_ALGO = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const HMAC_KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard
const AUTH_TAG_BYTES = 16;

// Sentinel dev-only keys. Sized to AES_KEY_BYTES / HMAC_KEY_BYTES. NEVER
// allowed in production — see `loadKeys()`.
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

/**
 * Resolve the encryption + HMAC keys, caching them for the process lifetime.
 * Exposed for tests via `resetKeyCacheForTests()` below; production code
 * should not call this directly.
 */
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

/**
 * For tests only — clears the cached key material so `NODE_ENV` /
 * `PHI_*` env changes take effect on the next call.
 */
export function resetMedicareIdKeyCacheForTests(): void {
  cachedKeys = null;
}

/**
 * Canonicalize an MBI value so two semantically-identical inputs hash and
 * encrypt to the same outputs from the user's POV:
 *   - strip leading/trailing whitespace
 *   - uppercase
 * We deliberately do NOT strip dashes — MBIs are formatted with dashes in
 * practice and we want round-trip decryption to preserve the original
 * formatting. If the same MBI is entered with vs. without dashes, those
 * are treated as different identifiers (matching today's behavior).
 */
export function normalizeMedicareId(plain: string): string {
  return plain.trim().toUpperCase();
}

/**
 * Encrypt + hash a medicare_id for storage. Returns the bytea-shaped Buffer
 * pair to write into the two new columns. The hash is deterministic; the
 * ciphertext is not.
 */
export function encryptMedicareId(plain: string): {
  encrypted: Buffer;
  hash: Buffer;
} {
  const normalized = normalizeMedicareId(plain);
  const { aesKey, hmacKey } = loadKeys();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Layout: IV (12) || authTag (16) || ciphertext
  const encrypted = Buffer.concat([iv, authTag, ciphertext]);

  const hash = createHmac("sha256", hmacKey).update(normalized, "utf8").digest();

  return { encrypted, hash };
}

/**
 * Decrypt a previously-stored medicare_id ciphertext back to its
 * normalized plaintext. Accepts Buffer or Uint8Array (PGlite returns
 * `Uint8Array` from bytea columns, node-postgres returns `Buffer`).
 */
export function decryptMedicareId(encrypted: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(encrypted)
    ? encrypted
    : Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);

  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("encrypted medicare_id payload too short");
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

/**
 * Compute just the deterministic lookup hash for a candidate plaintext.
 * Used by search + commission-reconcile call sites that only need to
 * compare against the stored `medicare_id_hash` column.
 */
export function hashMedicareId(plain: string): Buffer {
  const normalized = normalizeMedicareId(plain);
  const { hmacKey } = loadKeys();
  return createHmac("sha256", hmacKey).update(normalized, "utf8").digest();
}

/**
 * Feature flag for the dual-write → read-from-new-columns rollout. Default
 * OFF: writes populate both old and new columns but reads still use the
 * plaintext column. Flip to "true" after the backfill script has
 * populated every row.
 */
export function isMedicareIdEncryptionReadEnabled(): boolean {
  return process.env.MEDICARE_ID_ENCRYPTION_ENABLED === "true";
}
