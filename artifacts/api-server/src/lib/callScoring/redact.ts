/**
 * Minimum-necessary redaction applied to transcript text before ANY AI call
 * (and before hashing for duplicate detection). Covers the identifiers that
 * routinely come up on Medicare calls: Medicare Beneficiary Identifier (MBI),
 * SSN, card numbers, phone numbers, email addresses and dates of birth,
 * including numbers a speech-to-text engine spelled out in words.
 *
 * NOT removed: names and street addresses. They are hard to detect reliably and
 * give the reviewer context. That is why AI review only runs through the
 * BAA-covered provider gate (lib/ai/buildAiClient) and why this is called
 * "minimum necessary", not "de-identified".
 *
 * The numbers an agent is REQUIRED to read out (1-800-MEDICARE and its number,
 * 1-800-633-4227) are preserved so disclosure checks still work.
 */

const MBI_CHARS = "AC-HJKMNP-RT-Yac-hjkmnp-rt-y";
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const RULES: Array<[RegExp, string]> = [
  // Medicare Beneficiary Identifier: 11 chars, e.g. 1EG4-TE5-MK73
  [
    new RegExp(
      `\\b[1-9][${MBI_CHARS}][${MBI_CHARS}0-9]\\d-?[${MBI_CHARS}][${MBI_CHARS}0-9]\\d-?[${MBI_CHARS}]{2}\\d{2}\\b`,
      "g",
    ),
    "[MBI]",
  ],
  [/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, "[SSN]"],
  [/\b(?:\d[ -]?){13,16}\b/g, "[CARD]"],
  [/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[PHONE]"],
  // Seven-digit local numbers ("555-0123"). A separator is required so bare
  // 7-digit ids are not over-matched.
  [/\b\d{3}[ .-]\d{4}\b/g, "[PHONE]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  // 04/12/1951, 4-12-51
  [/\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}\b/g, "[DATE]"],
  // April 12th, 1951 / April 12 1951
  [new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}\\b`, "gi"), "[DATE]"],
  // Long runs of spelled-out digits: "five five five one two three four five six seven"
  [new RegExp(`\\b${DIGIT_WORD}(?:[ ,.-]+${DIGIT_WORD}){6,}\\b`, "gi"), "[NUMBER]"],
];

// Toll-free numbers the agent is required to read must survive.
const KEEP = /\b1[ .-]?800[ .-]?(?:medicare|633[ .-]?4227)\b/gi;

export function redactPHI(text: string): string {
  const kept: string[] = [];
  let out = text.replace(KEEP, (m) => {
    kept.push(m);
    return `\u0000${kept.length - 1}\u0000`;
  });
  for (const [re, label] of RULES) out = out.replace(re, label);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");
}
