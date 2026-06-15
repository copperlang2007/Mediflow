/**
 * Shared contact serializer for HIPAA PHI masking.
 *
 * The plaintext `medicare_id` column was dropped in migration 0017, so the
 * MBI lives only as AES-256-GCM ciphertext in `medicareIdEncrypted`. The API
 * contract still exposes a `medicareId` string field, so we DERIVE it here:
 *   - privileged roles: decrypt the ciphertext back to plaintext.
 *   - everyone else: a fixed masked sentinel when an MBI is on file.
 *
 * `dob` and `healthConditions` are masked for non-privileged roles.
 *
 * This lives in its own module (rather than inside `routes/contacts.ts`) so
 * that every route returning contact rows — contacts, leads, retention CRM,
 * etc. — applies the same masking policy instead of leaking raw PHI.
 */
import { decryptMedicareId } from "@workspace/db";
import { PHI_PRIVILEGED_ROLES, type Role } from "./permissions";

export const MASKED_MEDICARE_ID = "***-**-****";

export function serializeContact<
  T extends {
    dob?: Date | null;
    medicareIdEncrypted?: Buffer | Uint8Array | null;
    medicareIdHash?: Buffer | Uint8Array | null;
    healthConditions?: string[] | null;
  },
>(
  contact: T,
  userRole: string,
): Omit<T, "medicareIdEncrypted" | "medicareIdHash"> & {
  medicareId: string | null;
} {
  const { medicareIdEncrypted, medicareIdHash: _hash, ...rest } = contact;
  const hasMbi = medicareIdEncrypted != null;
  const privileged = PHI_PRIVILEGED_ROLES.has(userRole as Role);

  let medicareId: string | null = null;
  if (hasMbi) {
    medicareId = privileged
      ? decryptMedicareId(medicareIdEncrypted as Buffer | Uint8Array)
      : MASKED_MEDICARE_ID;
  }

  return {
    ...rest,
    medicareId,
    dob: privileged ? (rest.dob ?? null) : null,
    healthConditions: privileged
      ? (rest.healthConditions ?? null)
      : rest.healthConditions != null
        ? []
        : null,
  };
}
