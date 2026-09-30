import type { Rubric } from "../types";

/**
 * Medicare Advantage / Part D sales-call rubric for TPMOs, FMOs and agencies.
 *
 * Citations point at the governing rule so a reviewer can verify each check.
 * Where we are not certain of an exact paragraph we cite the section only —
 * never an invented paragraph number. This is a QA tool, not legal advice:
 * have your compliance officer review before relying on it for audits. It
 * assists review; it is not a compliance certification.
 *
 * Ported from the myCALL rubric with two deliberate changes: the "health
 * conditions" needs-analysis element was removed, and no structured
 * "extract" fields are pulled from the call, because health answers must
 * never feed scoring or routing. Only what the AGENT said or asked is scored.
 *
 * Patterns are regex sources matched against normalized text (lowercase,
 * punctuation removed, apostrophes dropped: "we're" -> "were", "don't" -> "dont").
 */
export const medicareRubric: Rubric = {
  id: "medicare-tpmo",
  name: "Medicare sales call — CMS/TPMO compliance + quality",
  version: "2026.1",
  description:
    "Scores Medicare Advantage / Part D sales calls against CMS marketing rules (TPMO disclaimer, scope of appointment, prohibited conduct) and sales-quality skills (needs analysis, plan fit, informed enrollment).",
  passThreshold: 80,
  sections: [
    { id: "disclosures", name: "Required disclosures", description: "What the agent must say, and when." },
    { id: "conduct", name: "Prohibited conduct", description: "Statements CMS prohibits in Medicare marketing." },
    { id: "discovery", name: "Needs analysis", description: "Did the agent learn what the beneficiary actually needs?" },
    { id: "presentation", name: "Plan presentation & enrollment", description: "Was the recommendation suitable and the enrollment informed?" },
    { id: "skills", name: "Communication skills" },
  ],
  criteria: [
    // ---- Required disclosures ------------------------------------------------
    {
      id: "tpmo_disclaimer",
      sectionId: "disclosures",
      name: "TPMO disclaimer within the first minute",
      description:
        "Agent reads the standardized TPMO disclaimer within the first minute of the sales call: we do not offer every plan in your area; how many organizations/plans we represent; contact Medicare.gov, 1-800-MEDICARE, or your local SHIP for all options.",
      citation: "42 CFR 422.2267(e)(41) and 423.2267(e)(41)",
      points: 15,
      severity: "critical",
      kind: "required",
      evaluator: "hybrid",
      withinSeconds: 60,
      components: [
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
      ],
      guidance:
        "Pass only if all three elements are conveyed in substance within the first 60 seconds. A paraphrase is acceptable only if it is materially equivalent. Cite the utterances.",
      hint: "Read the TPMO disclaimer now: not every plan · # of organizations/plans · Medicare.gov / 1-800-MEDICARE / SHIP.",
    },
    {
      id: "recording_notice",
      sectionId: "disclosures",
      name: "Call-recording notice",
      description:
        "Agent tells the beneficiary the call is recorded. CMS requires TPMOs to record marketing, sales and enrollment calls; many states require every party's consent to be recorded.",
      citation: "42 CFR 422.2274(g)(2)(ii) (recording requirement); state all-party-consent laws",
      points: 5,
      severity: "major",
      kind: "required",
      evaluator: "rules",
      withinSeconds: 120,
      patterns: [
        "(this|the|our) (call|conversation) (is|may be|will be|might be|is being|are being) (being )?(recorded|monitored)",
        "(recorded|monitored) (line|call)",
        "(im|i am|we are|were|i will be|well be) recording (this|the|our) (call|conversation)",
        "calls? (are|is) recorded",
      ],
      hint: "Tell the caller the call is recorded.",
    },
    {
      id: "agent_identification",
      sectionId: "disclosures",
      name: "Agent identifies self as a licensed agent",
      description: "Agent gives their name and states they are a licensed insurance agent early in the call.",
      citation: "CMS Medicare Communications & Marketing Guidelines (agent identification)",
      points: 5,
      severity: "major",
      kind: "required",
      evaluator: "hybrid",
      withinSeconds: 120,
      components: [
        { id: "name", label: "States their name", patterns: ["my name is", "(this|it) is [a-z]+ (with|from|at)", "(im|i am) [a-z]+ (with|from|at)"] },
        {
          id: "licensed",
          label: "Says they are a licensed agent",
          patterns: ["licensed (health |medicare |insurance |sales )*(agent|broker|representative|advisor|specialist)"],
        },
      ],
      hint: "Introduce yourself by name as a licensed insurance agent.",
    },
    {
      id: "scope_of_appointment",
      sectionId: "disclosures",
      name: "Scope of appointment confirmed before plan discussion",
      description:
        "Before discussing specific plans the agent documents or confirms the scope of appointment — which product types (MA, Part D, Medigap, dental…) the beneficiary agreed to discuss.",
      citation: "42 CFR 422.2264(c)(3)",
      points: 10,
      severity: "critical",
      kind: "required",
      evaluator: "hybrid",
      // The confirmation must come before the agent starts on specific plans.
      mustPrecede: [
        "(humana|aetna|united ?healthcare|uhc|wellcare|cigna|anthem|blue cross|kaiser|devoted|clover|bcbs)",
        "(this|that|the|our|your) (plan|policy) (has|comes with|includes|offers|covers|is|would|will)",
        "(premium|copay|co pay|deductible|out of pocket maximum|maximum out of pocket|formulary|in network|part d deductible)s? (is|are|of|would be|will be|starts|start|comes|come)",
        "(zero|no|\\d+) (dollar )?(premium|copay|co pay)",
        "(plan|plans) (that|which) (has|have|includes|include|covers|cover)",
      ],
      patterns: [
        "scope of (the )?appointment",
        "s o a",
        "soa",
        "(agree|consent|okay|ok|permission) to (discuss|talk about|review|go over) (medicare advantage|part d|prescription drug|supplement|medigap|the plans|plans|these products)",
        "(products|plan types|types of plans) (we|well|we will|were going to|we are going to|i will|ill) (discuss|talk about|review|go over)",
      ],
      guidance:
        "Pass if the agent obtains verbal scope-of-appointment consent on the call, or clearly references an SOA already completed, BEFORE presenting specific plans. Fail if plans are presented with no SOA at all. Mark na only if no Medicare plan was discussed.",
      hint: "Confirm the scope of appointment before presenting plans.",
    },

    // ---- Prohibited conduct --------------------------------------------------
    {
      id: "no_government_affiliation",
      sectionId: "conduct",
      name: "No claim of Medicare / government affiliation",
      description: "Agent never states or implies they are calling from, or endorsed by, Medicare, CMS, Social Security or the government.",
      citation: "42 CFR 422.2262 and 423.2262 (misleading communications)",
      points: 10,
      severity: "critical",
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "(calling|call you|reaching out) (from|on behalf of) (medicare|social security|the government|cms)",
        "(im|i am|were|we are|this is) (with|from|calling from) (medicare|social security|the government|cms)(?! (advantage|supplement|plans?|part))",
        "(medicare|social security|the government|cms) (sent|asked|told) (me|us)",
        "(im|i am|were|we are) (a |an )?(medicare|government|social security) (representative|rep|agent|employee|official)",
        "(medicare|government) (office|department) (calling|here)",
        "(endorsed|approved|recommended) by (medicare|cms|the government)",
      ],
      guidance:
        "A violation is any statement that the agent is from, works for, or is endorsed by Medicare/CMS/SSA/the government. Saying they sell Medicare plans, or reading 'Medicare.gov' in the disclaimer, is NOT a violation.",
      hint: "Never imply you are from Medicare or the government.",
    },
    {
      id: "no_superlatives",
      sectionId: "conduct",
      name: "No unsubstantiated superlatives",
      description: "Agent does not call a plan 'the best', 'number one', 'top-rated', or 'the cheapest' without a cited, substantiated source.",
      citation: "42 CFR 422.2262 (superlatives must be substantiated)",
      points: 5,
      severity: "major",
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "(the|your) best (plan|option|coverage|deal|benefits|company|choice)",
        "best plan",
        "number one (plan|company|rated|choice)",
        "(top|highest) rated (plan|company)",
        "(cheapest|lowest (priced|cost|premium)) plan (in|anywhere|available)",
      ],
      guidance:
        "Violation only when the agent makes an unsubstantiated superlative claim. Citing a verifiable source (e.g., 'this plan has a 5-star CMS rating') is allowed. Negated or hypothetical use ('I can't tell you which is best') is not a violation.",
      hint: "Avoid 'best'/'#1' claims — describe how the plan fits their needs instead.",
    },
    {
      id: "no_pressure",
      sectionId: "conduct",
      name: "No high-pressure or scare tactics",
      description: "Agent does not use false urgency, threats of losing benefits, or pressure to decide immediately.",
      citation: "42 CFR 422.2262 and 422.2264",
      points: 5,
      severity: "major",
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "act (now|fast|today)",
        "today only",
        "(only|just) (for )?today",
        "limited time (offer|only)",
        "last chance",
        "before (it|this|the offer) (runs out|goes away|expires)",
        "(you ll|youll|you will|you could|you might|you re going to|youre going to) lose (your )?(medicare|benefits|coverage|doctors?|social security)",
        "(have|need|got) to (decide|sign up|enroll|do this) (right now|today|now)",
        "offer (ends|expires) (today|tonight)",
      ],
      guidance:
        "Accurately stating a real enrollment-period deadline is allowed. Flag false urgency, threats, or refusing to let the beneficiary take time to decide.",
      hint: "Don't pressure — give them time to decide.",
    },
    {
      id: "no_guarantees",
      sectionId: "conduct",
      name: "No guarantees or promises of savings/benefits",
      description: "Agent does not guarantee savings, approval, or benefits the plan cannot contractually promise.",
      citation: "42 CFR 422.2262 (misleading communications)",
      points: 5,
      severity: "major",
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "(i|we) (can )?(guarantee|promise)(?! (issue|issued|renewable))",
        "guaranteed (savings|to save|approval|benefits|money|lower)",
        "(you ll|youll|you will) (definitely|for sure|100 percent|absolutely) (save|get|qualify|pay less)",
      ],
      guidance: "'Guaranteed issue' and 'guaranteed renewable' are legitimate Medigap terms, not violations.",
      hint: "Don't promise savings or benefits — describe what the plan documents say.",
    },
    {
      id: "no_misleading_benefits",
      sectionId: "conduct",
      name: "No misleading 'free money' / giveback claims",
      description: "Agent does not hype 'free money', cash cards or Social Security increases in a misleading way, or promise benefits the beneficiary may not qualify for.",
      citation: "42 CFR 422.2262 (misleading communications)",
      points: 5,
      severity: "major",
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "free money",
        "extra money (in|back in|added to) your (social security|check)",
        "(cash|money) (card|back) (every|each) month",
        "(increase|raise|boost) your social security",
        "free (groceries|food card|cash)",
      ],
      guidance:
        "Accurately describing a specific plan's Part B premium reduction or supplemental benefit, with its eligibility conditions, is allowed. Flag vague or exaggerated 'free money' claims.",
      hint: "Describe benefits precisely, with eligibility conditions — no 'free money' hype.",
    },

    // ---- Needs analysis ----------------------------------------------------
    {
      id: "needs_analysis",
      sectionId: "discovery",
      name: "Needs analysis covered",
      description:
        "The conversation covers the beneficiary's doctors, prescriptions, current coverage, budget, hospital preferences, dental/vision/hearing and travel. Full credit at 5 of 7; partial below.",
      citation: "Suitability best practice; supports 42 CFR 422.2274 agent oversight",
      points: 15,
      severity: "major",
      kind: "required",
      evaluator: "rules",
      // The AGENT asking counts. What the client volunteers is not the agent's work.
      // With no agent label the words are found in unknown speech and go to a person.
      speaker: "agent",
      minComponents: 5,
      components: [
        { id: "doctors", label: "Doctors / providers", patterns: ["doctors?", "physicians?", "specialists?", "providers?", "primary care", "pcp"] },
        { id: "prescriptions", label: "Prescriptions / pharmacy", patterns: ["prescriptions?", "medications?", "medicines?", "meds", "drugs?", "pharmac(y|ies)"] },
        {
          id: "current_coverage",
          label: "Current coverage",
          patterns: [
            "current (plan|coverage|insurance)",
            "currently (have|on|enrolled)",
            "original medicare",
            "medigap",
            "medicaid",
            "employer (coverage|plan|insurance)",
            "retiree (coverage|plan|insurance)",
            "tricare",
            "va benefits",
          ],
        },
        { id: "budget", label: "Budget / costs", patterns: ["budget", "afford", "premiums?", "monthly (cost|payment)", "out of pocket"] },
        { id: "hospital", label: "Hospital preferences", patterns: ["hospitals?", "surgery", "inpatient"] },
        { id: "extras", label: "Dental / vision / hearing", patterns: ["dental", "vision", "hearing", "glasses", "dentures"] },
        { id: "travel", label: "Travel / residency", patterns: ["travel", "out of state", "snowbird", "part of the year"] },
      ],
      hint: "Ask about doctors, prescriptions, current coverage, budget, hospitals, extras and travel.",
    },

    // ---- Presentation & enrollment ------------------------------------------
    {
      id: "plan_explanation",
      sectionId: "presentation",
      name: "Plan costs and rules explained clearly",
      description:
        "For any plan presented: premium, deductibles, copays/coinsurance, maximum out-of-pocket, network restrictions (HMO/PPO), and drug coverage are explained in plain language.",
      citation: "42 CFR 422.2262 (accurate, not misleading)",
      points: 10,
      severity: "major",
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no specific plan was presented. Partial credit if some cost elements were omitted.",
    },
    {
      id: "recommendation_fit",
      sectionId: "presentation",
      name: "Recommendation fits stated needs",
      description: "Any recommendation is explicitly tied to the beneficiary's doctors, drugs, budget and preferences, and provider/drug coverage was verified.",
      citation: "Suitability best practice",
      points: 10,
      severity: "major",
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no recommendation was made. Fail if the agent recommended a plan without checking doctors or prescriptions the beneficiary mentioned.",
    },
    {
      id: "informed_enrollment",
      sectionId: "presentation",
      name: "Informed, voluntary enrollment (Pre-Enrollment Checklist)",
      description:
        "If an enrollment happened: the agent reviewed Pre-Enrollment Checklist items (network, costs, drug coverage, effective date, effect on current coverage — including Medigap underwriting risk), confirmed understanding, and got clear voluntary consent.",
      citation: "CMS Pre-Enrollment Checklist (42 CFR 422.2267(e)); 42 CFR 422.2274",
      points: 10,
      severity: "critical",
      kind: "judgment",
      evaluator: "llm",
      guidance:
        "Mark na if no enrollment or application was taken on this call. Fail if the beneficiary was enrolled without understanding the network, costs, or that the change replaces their current coverage.",
    },
    {
      id: "respects_decision",
      sectionId: "presentation",
      name: "Respects the beneficiary's decision",
      description: "Beneficiary had room to ask questions; the agent checked understanding and respected hesitation or a 'no'.",
      points: 5,
      severity: "major",
      kind: "judgment",
      evaluator: "llm",
    },

    // ---- Skills -----------------------------------------------------------
    {
      id: "rapport",
      sectionId: "skills",
      name: "Rapport and empathy",
      description: "Warm, patient, respectful tone; acknowledges the beneficiary's concerns.",
      points: 5,
      severity: "minor",
      kind: "judgment",
      evaluator: "llm",
    },
    {
      id: "active_listening",
      sectionId: "skills",
      name: "Active listening",
      description: "Asks open questions, follows up on what the beneficiary says, doesn't talk over them.",
      points: 5,
      severity: "minor",
      kind: "judgment",
      evaluator: "llm",
    },
    {
      id: "objection_handling",
      sectionId: "skills",
      name: "Objection handling",
      description: "Acknowledges objections, clarifies the real concern, answers accurately without pressure.",
      points: 5,
      severity: "minor",
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if the beneficiary raised no objections.",
    },
    {
      id: "clear_next_steps",
      sectionId: "skills",
      name: "Clear next steps",
      description: "Call ends with a clear summary and agreed next step (enrollment confirmation, follow-up date, documents to send).",
      points: 5,
      severity: "minor",
      kind: "judgment",
      evaluator: "llm",
    },
  ],
};
