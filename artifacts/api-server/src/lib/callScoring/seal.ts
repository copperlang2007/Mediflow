/**
 * PHI field encryption for call-scoring text, using the same AES-256-GCM
 * helpers (and PHI_ENCRYPTION_KEY / PHI_HMAC_KEY) as contacts.medicare_id and
 * onboarding SSNs. Transcript text, quotes and reviewer notes are only ever
 * stored sealed.
 */
import { decryptPii, encryptPii, hashPii } from "@workspace/db";
import type { ParsedTranscript, Utterance } from "./types";
import { redactPHI } from "./redact";

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

/** HMAC of the PHI-redacted canonical text: recognises a re-import without keeping plaintext. */
export function redactedTextHash(parsed: ParsedTranscript): Buffer {
  const canonical = parsed.utterances.map((u) => `${u.role}:${redactPHI(u.text)}`).join("\n");
  return hashPii(canonical);
}
