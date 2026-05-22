/**
 * Versioned consent text shown to e-signature signers (Beta).
 *
 * The exact text + its semver-style version are persisted on every signed
 * envelope's `consent_record` so we can prove what the signer agreed to
 * even if the text changes later. Bump the version whenever the wording
 * changes in a way that affects the legal meaning.
 *
 * `{{ESIGN_PAPER_COPY_CONTACT}}` is a placeholder string — INSUREitALL
 * will swap in their admin contact pre-launch. We intentionally keep the
 * placeholder in the persisted text so the audit trail records exactly
 * what the signer saw at the time.
 */

export const ESIGN_CONSENT_VERSION = "1.0.0";

export const ESIGN_CONSENT_TEXT = [
  "By signing electronically, I agree to conduct business electronically and acknowledge that my electronic signature has the same legal effect as a handwritten signature.",
  "I confirm I have read and understood this document and intend to sign it.",
  "I understand I can request a paper copy of this document by contacting {{ESIGN_PAPER_COPY_CONTACT}}.",
  "I can withdraw consent to electronic signing at any time before completing this signature by closing this window.",
].join(" ");
