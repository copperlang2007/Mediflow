/**
 * PHI field encryption for call-scoring text, using the same AES-256-GCM
 * helpers (and PHI_ENCRYPTION_KEY / PHI_HMAC_KEY) as contacts.medicare_id and
 * onboarding SSNs. Transcript text, quotes and reviewer notes are only ever
 * stored sealed.
 */
import { decryptPii, encryptPii, hashPii } from "@workspace/db";
import type { ParsedTranscript, Utterance } from "./types";

export function seal(value: unknown): Buffer {
  return encryptPii(JSON.stringify(value)).encrypted;
}

export function open<T>(sealed: Buffer | Uint8Array | null | undefined): T | null {
  if (!sealed) return null;
  try {
    return JSON.parse(decryptPii(sealed)) as T;
  } catch {
    return null;
  }
}

export interface TranscriptPayload {
  v: 1;
  utterances: Utterance[];
  /** The uploaded file's name. It can contain a client's name, so it is only kept sealed. */
  filename: string | null;
  /** The phone number given with the upload, kept sealed. */
  phone: string | null;
  /** Set when a reviewer chose which voice is the agent on a one-track recording. */
  speakerAssignment?: { agentLabel: string; userId: string; at: string; /** Unique per choice, so two choices in the same millisecond still differ. */ id: string; /** The id of the choice the latest saved score was made under. Differs from `id` while a score is missing. */ scoredId?: string };
}

export function sealTranscript(parsed: ParsedTranscript, extra: { filename?: string | null; phone?: string | null }): Buffer {
  const payload: TranscriptPayload = {
    v: 1,
    utterances: parsed.utterances,
    filename: extra.filename ?? null,
    phone: extra.phone ?? null,
  };
  return seal(payload);
}

/**
 * Keyed digest (HMAC with the app's PHI_HMAC_KEY) of the ORIGINAL canonical
 * speech. It is deliberately not computed from redacted text: two different
 * calls that differ only in masked values (a phone number, a date of birth)
 * must not collapse into one. Recognises a true re-import without keeping
 * plaintext.
 */
export function contentDigest(parsed: ParsedTranscript): Buffer {
  const canonical = parsed.utterances
    .map((u) => `${u.role}:${u.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return hashPii(canonical);
}
