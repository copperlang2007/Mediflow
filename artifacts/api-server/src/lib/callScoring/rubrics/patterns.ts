/**
 * Phrase patterns shared by the Medicare rubrics. Regex sources matched
 * against normalized text (lowercase, punctuation removed, apostrophes
 * dropped). Changing one changes every rubric that uses it.
 */
import type { PhraseComponent } from "../types";

export const TPMO_COMPONENTS: PhraseComponent[] = [
  {
    id: "not_every_plan",
    label: "“We do not offer every plan available in your area”",
    patterns: ["(do not|dont) offer (every|each|all(?: of)?(?: the)?) plans?", "not every plan (available )?in your area"],
  },
  {
    id: "represent_count",
    label: "Number of organizations / plans represented",
    patterns: [
      "represent (?:[a-z0-9]+ ){1,6}?(organizations?|companies|carriers)",
      "(organizations?|companies|carriers) (which|that) offer (?:[a-z0-9]+ ){0,4}?(plans|products)",
      "limited to (those|the) plans (we|i) (do )?offer",
    ],
  },
  {
    id: "all_options",
    label: "Medicare.gov, 1-800-MEDICARE or local SHIP",
    patterns: [
      "medicare (dot )?gov",
      "(1 )?800 medicare",
      "1800 medicare",
      "one (eight hundred|800) medicare",
      "state health insurance( assistance)? program",
      "local ship",
    ],
  },
];

export const RECORDING_PATTERNS: string[] = [
  "(this|the|our) (call|conversation) (is|may be|will be|might be|is being|are being) (being )?(recorded|monitored)",
  "(recorded|monitored) (line|call)",
  "(im|i am|we are|were|i will be|well be) recording (this|the|our) (call|conversation)",
  "calls? (are|is) recorded",
];

export const PLAN_SPECIFIC_PATTERNS: string[] = [
  "(humana|aetna|united ?healthcare|uhc|wellcare|cigna|anthem|blue cross|kaiser|devoted|clover|bcbs) (?:[a-z0-9]+ ){0,3}?(ppo|hmo|dsnp|snp|pdp|plan) (has|comes with|includes|offers|covers|gives|is a|is an|is the)",
  "(this|that|the|your) (plan|policy) (has|comes with|includes|offers|covers)",
  "(premium|copay|co pay|deductible|out of pocket maximum|maximum out of pocket|part d deductible)s? (is|are|would be|will be|starts at|of) (zero|free|only|just|\\d+)",
  "(has|comes with|includes|with) (a )?(zero|no|\\d+) (dollar )?(premium|copay|co pay)",
];

export const GOVERNMENT_AFFILIATION_PATTERNS: string[] = [
  "(calling|call you|reaching out) (from|on behalf of) (medicare|social security|the government|cms)",
  "(im|i am|were|we are|this is) (with|from|calling from) (medicare|social security|the government|cms)(?! (advantage|supplement|plans?|part))",
  "(medicare|social security|the government|cms) (sent|asked|told) (me|us)",
  "(im|i am|were|we are) (a |an )?(medicare|government|social security) (representative|rep|agent|employee|official)",
  "(medicare|government) (office|department) (calling|here)",
  "(endorsed|approved|recommended) by (medicare|cms|the government)",
];

export const SUPERLATIVE_PATTERNS: string[] = [
  "(the|your) best (plan|option|coverage|deal|benefits|company|choice)",
  "best plan",
  "number one (plan|company|rated|choice)",
  "(top|highest) rated (plan|company)",
  "(cheapest|lowest (priced|cost|premium)) plan (in|anywhere|available)",
];

export const PRESSURE_PATTERNS: string[] = [
  "act (now|fast|today)",
  "today only",
  "(only|just) (for )?today",
  "limited time (offer|only)",
  "last chance",
  "before (it|this|the offer) (runs out|goes away|expires)",
  "(you ll|youll|you will|you could|you might|you re going to|youre going to) lose (your )?(medicare|benefits|coverage|doctors?|social security)",
  "(have|need|got) to (decide|sign up|enroll|do this) (right now|today|now)",
  "offer (ends|expires) (today|tonight)",
];

export const GUARANTEE_PATTERNS: string[] = [
  "(i|we) (can )?(guarantee|promise)(?! (issue|issued|renewable))",
  "guaranteed (savings|to save|approval|benefits|money|lower)",
  "(you ll|youll|you will) (definitely|for sure|100 percent|absolutely) (save|get|qualify|pay less)",
];
