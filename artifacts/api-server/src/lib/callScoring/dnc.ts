/**
 * Do-not-contact detector.
 *
 * Consent and requests to stop contact live on call recordings. This finds
 * phrases such as "stop calling me", "take me off your list", "I'm on the do
 * not call list" or "quit texting" in what the CLIENT said (or in unlabelled
 * speech when the file has no speaker labels) and raises a "possible
 * do-not-contact request" with the exact words.
 *
 * It is deliberately deterministic and negation-aware ("I'd never say stop
 * calling" does not fire), it never looks at agent speech, and it NEVER
 * applies an opt-out by itself. A person confirms every one (see the
 * do-not-contact review queue in routes/callScoring.ts).
 *
 * A missed request is worse than an extra click, so the patterns lean toward
 * catching; the negation rules only remove clear "not really asking" cases.
 */
import type { ParsedTranscript, Role, Utterance } from "./types";
import { normalizeMapped, wordsBefore } from "./text";

export interface DncPattern {
  id: string;
  source: string;
  /**
   * How negation is judged. "adjacent" = a negator directly governs the phrase
   * ("never say stop calling"). "clause" = any negator earlier in the clause
   * ("I'm not on the do not call list"); used for bare mentions that carry no
   * negation of their own.
   */
  negation: "adjacent" | "clause";
}

const STOP_OBJECT =
  "(?:calling|calls|texting|texts|contacting|messaging|messages|emailing|emails|phoning|phone calls|bothering|harassing|pestering|ringing)";

export const DNC_PATTERNS: DncPattern[] = [
  {
    id: "stop_contact",
    negation: "adjacent",
    source: `(?:stop|quit|cease) (?:all )?(?:the |these |those |any |your )?${STOP_OBJECT}`,
  },
  {
    id: "stop_sending",
    negation: "adjacent",
    source: "(?:stop|quit|cease) sending (?:me |us )?(?:the |any |more )?(?:texts|text messages|messages|emails|mail)",
  },
  {
    id: "remove_from_list",
    negation: "adjacent",
    source:
      "(?:take|remove|delete|erase|drop|put) (?:me|us|my (?:number|name|phone number|cell number|cell|info|information|email|address)|this number|our number|my phone) (?:off|from|out of|on) (?:of )?(?:your|the|that|this|any|all|every) (?:(?:call|calling|contact|mailing|phone|marketing|texting|text|sms|email|do not call|dnc|dont call)(?: me)? )?(?:lists?|database|records|registry|system|files?)",
  },
  {
    id: "take_me_off",
    negation: "adjacent",
    source: "take (?:me|us|my number|this number) off",
  },
  {
    id: "remove_my_number",
    negation: "adjacent",
    source:
      "(?:remove|delete|erase|lose|forget|drop) (?:my|our|this) (?:number|name|phone number|info|information|email|contact information)",
  },
  {
    id: "add_to_dnc",
    negation: "adjacent",
    source:
      "(?:put|add|place|register|list) (?:me|us|my number|this number|my name|my phone number)(?: on| to| onto| in| into)? (?:the |your |a |that |this )?(?:national |internal |company )?(?:do not call|dont call|dnc|no call|no contact)(?: list| registry)?",
  },
  {
    id: "dont_contact_me",
    negation: "adjacent",
    source:
      "(?:do not|dont|never) (?:ever )?(?:call|contact|text|message|email|phone|ring|bother|harass) (?:me|us|this number|my number|my phone|here)(?: again| anymore| any more| ever again)?",
  },
  {
    id: "dont_call_again",
    negation: "adjacent",
    source: "(?:do not|dont|never) (?:ever )?(?:call|contact|text|phone) (?:again|anymore|any more|back)",
  },
  {
    id: "no_more_contact",
    negation: "adjacent",
    source: "no more (?:calls|calling|texts|texting|messages|messaging|emails|phone calls|contact)",
  },
  {
    id: "dont_want_calls",
    negation: "adjacent",
    source:
      "(?:do not|dont) (?:want|need|wish) (?:any )?(?:more |further |these |your |anymore )?(?:calls|phone calls|texts|text messages|messages|emails|contact|marketing)",
  },
  {
    id: "dont_want_you_to",
    negation: "adjacent",
    source:
      "(?:do not|dont) (?:want|wish) (?:you |anyone |anybody |your (?:company|people|agency) )?to (?:call|contact|text|message|email|phone|reach out to|bother)",
  },
  {
    id: "on_dnc_list",
    negation: "adjacent",
    source:
      "(?:im|i am|were|we are|my number is|this number is|my phone is|number is) (?:already |currently |still )?(?:on|registered on|listed on|signed up for|in) (?:the |a |that |your |their )?(?:national |federal |state |internal |company )?(?:do not call|dont call|dnc|no call)(?: list| registry| registration)?",
  },
  {
    id: "dnc_list_mention",
    negation: "clause",
    source:
      "(?:national |federal |state )?do not call (?:list|registry|registration)|dnc (?:list|registry)|dont call (?:list|registry)|registered (?:on|with) (?:the )?(?:do not call|dnc)",
  },
  {
    id: "leave_alone",
    negation: "adjacent",
    source: "leave (?:me|us) alone",
  },
  {
    id: "opt_out",
    negation: "adjacent",
    source:
      "unsubscribe|opt (?:me|us) out|opt out of (?:your |these |the )?(?:calls|texts|messages|list|emails|marketing)",
  },
];

const COMPILED = DNC_PATTERNS.map((p) => ({ ...p, re: new RegExp(`\\b(?:${p.source})\\b`, "g") }));

/** Words that may sit between a negator and the phrase without breaking the link. */
const FILLER = new Set([
  "ever", "really", "going", "to", "gonna", "want", "need", "have", "be", "say", "said", "saying", "tell",
  "telling", "ask", "asking", "asked", "mean", "meaning", "suggest", "suggesting", "just", "actually",
  "even", "you", "i", "id", "youd", "ill", "we", "they", "wish", "would", "will", "me", "us", "them",
]);
const NEGATORS = new Set([
  "never", "not", "wouldnt", "wont", "cant", "cannot", "couldnt", "shouldnt", "didnt", "neednt", "hardly",
  "dont", "doesnt", "nobody",
]);
const CLAUSE_NEGATORS = /\b(?:not|never|isnt|arent|wasnt|werent|havent|hasnt)\b/;
const HYPOTHETICAL = /\b(?:if|unless|whether|suppose|assuming)\b(.*)$/;

/**
 * True when the words before a phrase show it is NOT a request: a negator
 * governs it ("never say stop calling", "I don't want you to stop calling",
 * "I'm not asking you to stop calling"), or it is hypothetical ("if you want
 * us to stop calling") - unless the hypothetical is itself a demand ("if you
 * don't stop calling me...").
 */
export function dncLooksNegated(before: string, mode: DncPattern["negation"]): boolean {
  if (mode === "clause") return CLAUSE_NEGATORS.test(before);
  const words = before.split(" ").filter(Boolean);
  let i = words.length - 1;
  while (i >= 0 && FILLER.has(words[i]!)) i--;
  const governing = i >= 0 ? words[i]! : "";
  // "if you don't stop calling me ..." is a demand, not a hypothetical.
  if ((governing === "dont" || governing === "doesnt") && words.slice(0, i).some((w) => w === "if" || w === "unless")) {
    return false;
  }
  if (NEGATORS.has(governing) || (governing === "one" && words[i - 1] === "no")) {
    // "dont" only negates a phrase like "dont want you to ..." - reached through fillers above.
    return true;
  }
  const hypo = HYPOTHETICAL.exec(words.join(" "));
  if (hypo && !/\b(?:dont|do not|wont|not)\b/.test(hypo[1] ?? "")) return true;
  return false;
}

/**
 * Which channel the request is about. "email" only when the words name email and
 * nothing else ("stop emailing me"): an opt-out on the phone list would not stop
 * email, so those go through the email opt-out path. Everything else is "phone".
 */
export type DncChannel = "phone" | "email";

const EMAIL_WORDS = /\b(?:emails?|emailing|e mail)\b/;
const OTHER_CHANNEL_WORDS =
  /\b(?:calls?|calling|phones?|phoning|phone calls|texts?|texting|messages?|messaging|sms|ring|ringing|number|contact|contacting|mail|unsubscribe|opt|dnc|do not call|dont call|bothering|harassing|pestering|leave)\b/;

export function channelOf(matched: string): DncChannel {
  return EMAIL_WORDS.test(matched) && !OTHER_CHANNEL_WORDS.test(matched.replace(EMAIL_WORDS, " ")) ? "email" : "phone";
}

export interface DncFinding {
  channel: DncChannel;
  utteranceId: number;
  startOffset: number;
  endOffset: number;
  startSec: number;
  role: Role;
  /** The sentence containing the request, verbatim (capped). */
  quote: string;
  patternId: string;
  fingerprint: string;
}

const QUOTE_CAP = 300;

function sentenceAround(text: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !/[.!?]/.test(text[s - 1]!)) s--;
  let e = end;
  while (e < text.length && !/[.!?]/.test(text[e]!)) e++;
  if (e < text.length) e++;
  let out = text.slice(s, e).trim();
  if (out.length > QUOTE_CAP) {
    const from = Math.max(0, start - s - 100);
    out = text.slice(s + from, s + from + QUOTE_CAP).trim();
  }
  return out || text.slice(start, end);
}

function scanUtterance(u: Utterance): DncFinding | null {
  const { norm, map } = normalizeMapped(u.text);
  if (!norm) return null;
  const hits: Array<{ from: number; to: number; id: string; negation: DncPattern["negation"] }> = [];
  for (const p of COMPILED) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(norm)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      hits.push({ from: m.index, to: m.index + m[0].length, id: p.id, negation: p.negation });
    }
  }
  hits.sort((a, b) => a.from - b.from || b.to - a.to);
  for (const h of hits) {
    const startOffset = map[h.from] ?? 0;
    const endOffset = (map[h.to - 1] ?? u.text.length - 1) + 1;
    const before = wordsBefore(u, startOffset, 6, "clause");
    if (dncLooksNegated(before, h.negation)) continue;
    return {
      channel: channelOf(norm.slice(h.from, h.to)),
      utteranceId: u.id,
      startOffset,
      endOffset,
      startSec: u.startSec,
      role: u.role,
      quote: sentenceAround(u.text, startOffset, endOffset),
      patternId: h.id,
      fingerprint: `dnc:${u.id}:${startOffset}`,
    };
  }
  return null;
}

/**
 * Possible do-not-contact requests: client speech, or unlabelled speech when
 * the transcript has no speaker labels. Agent speech is never examined, so an
 * agent reading a script or repeating "do not call" cannot trigger it.
 */
export function detectDncRequests(transcript: ParsedTranscript): DncFinding[] {
  const out: DncFinding[] = [];
  for (const u of transcript.utterances) {
    if (u.role === "agent") continue;
    const f = scanUtterance(u);
    if (f) out.push(f);
  }
  return out;
}
