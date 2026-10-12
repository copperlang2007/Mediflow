import type { Criterion, Rubric } from "../types";
import { GUARANTEE_PATTERNS, PLAN_SPECIFIC_PATTERNS, PRESSURE_PATTERNS, RECORDING_PATTERNS, SUPERLATIVE_PATTERNS, TPMO_COMPONENTS } from "./patterns";

/**
 * IIA 2026 Medicare Telephonic Sales & Enrollment Script — QA Compliance
 * Scorecard (weighted 150-point CMS compliance evaluation).
 *
 * Transcribed from the IIA 2026 QA Compliance Scorecard: 19 sections in call
 * order (section 19, conduct, is judged across the whole call), the same item
 * numbers, points and auto-fail flags, and the scorecard's own disposition
 * wording. The scorecard's rules map onto the engine as follows:
 *
 *  - Auto-fail ("Y") items are critical and all-or-nothing: anything short of
 *    full credit fails the call ("AUTOMATIC FAIL – NON-COMPLIANT") whatever
 *    the points.
 *  - Not-applicable items earn full points (naCredit "full"), as the
 *    scorecard instructs. Items that only apply to some calls (SNP plans,
 *    calls that reach enrollment, TPV) are "conditional": the AI reviewer
 *    says when one does not apply and quotes why, and a person confirms
 *    before a critical item is left out.
 *  - Pass mark 120 / 150 (80%).
 *
 * As the scorecard itself says, this reflects public CMS guidance as of August
 * 2026; confirm current-year requirements and carrier overlays with your
 * compliance department. It assists a human reviewer; it is not a compliance
 * certification or legal advice.
 *
 * Patterns are regex sources matched against normalized text (lowercase,
 * punctuation removed, apostrophes dropped).
 */

const MCMG = "CMS Medicare Communications and Marketing Guidelines (MCMG)";
const RECORDING_RULE = "42 CFR 422.2274(g) and 423.2274(g) (call recording)";
const TPMO_RULE = "42 CFR 422.2267(e)(41) and 423.2267(e)(41) (TPMO disclaimer)";
const SOA_RULE = "42 CFR 422.2264(c)(3) (scope of appointment)";
const MARKETING_RULE = "42 CFR 422.2262 and 423.2262 (misleading or confusing communications)";

const FAIL = "AUTOMATIC FAIL – NON-COMPLIANT:";
const EXCLUDED = "Call excluded from submission; escalated to Compliance.";

/** An auto-fail ("Y") item: critical, all-or-nothing, with the scorecard's disposition wording. */
function autoFail(c: Omit<Criterion, "severity" | "allOrNothing">): Criterion {
  return { ...c, severity: "critical", allOrNothing: true };
}

/** Non-auto-fail items: 3 points and up are "major", smaller ones "minor" (labels only; points decide the score). */
function item(c: Omit<Criterion, "severity">): Criterion {
  return { ...c, severity: c.points >= 3 ? "major" : "minor" };
}

const ENROLLMENT_ONLY =
  'Applies only if the call proceeded to an enrollment or application. If it did not, return "na" and quote the words that show it stopped (e.g. the client declining or asking to think about it).';

export const iia2026Rubric: Rubric = {
  id: "iia-2026-qa",
  name: "IIA 2026 QA Compliance Scorecard (150 pts)",
  version: "2026.1",
  description:
    "Weighted 150-point evaluation of a Medicare Advantage / Part D telephonic sales and enrollment call against the IIA 2026 script: MCMG, TPMO, scope of appointment, required enrollment disclosures and conduct. Pass at 120/150 (80%); any auto-fail item fails the call.",
  passThreshold: 80,
  naCredit: "full",
  outcomeLabels: {
    pass: "PASS",
    belowThreshold: "FAIL – BELOW THRESHOLD",
    autoFail: "AUTOMATIC FAIL – NON-COMPLIANT",
    review: "NEEDS A REVIEWER",
  },
  sections: [
    { id: "s01-opening", name: "1. Opening & Recorded-Line Disclosure" },
    { id: "s02-tpmo", name: "2. TPMO Disclosure, Callback Consent & Non-Affiliation Statement" },
    { id: "s03-eligibility", name: "3. Eligibility & Prior-Coverage Screening" },
    { id: "s04-identity", name: "4. Client Identity Verification" },
    { id: "s05-soa", name: "5. Scope of Appointment (SOA)" },
    { id: "s06-coverage", name: "6. Provider & Prescription Coverage Verification" },
    { id: "s07-election", name: "7. Election Period / SEP Validation" },
    { id: "s08-plan-review", name: "8. Plan Review Checklist & SNP Eligibility Verification" },
    { id: "s09-pre-enrollment", name: "9. Mandatory Pre-Enrollment Checklist — Plan Type & SNP Disclosures" },
    { id: "s10-priorities", name: "10. Priorities Recap" },
    { id: "s11-disclosure", name: "11. Pre-Enrollment Disclosure" },
    { id: "s12-consent", name: "12. Enrollment Application & Recorded Consent" },
    { id: "s13-restatement", name: "13. Benefits Review, Government & TPMO Restatement" },
    { id: "s14-contact", name: "14. Applicant & Contact Information" },
    { id: "s15-hra", name: "15. HRA Completion & Welcome Packet Confirmation" },
    { id: "s16-extra-help", name: "16. Extra Help Program & Personal Security Code" },
    { id: "s17-satisfaction", name: "17. Customer Satisfaction Team Disclosures" },
    { id: "s18-closing", name: "18. Call Closing, Wrap-Up & TPV" },
    { id: "s19-conduct", name: "19. Compliance Conduct Standards — scored after the whole call" },
  ],
  criteria: [
    // ---- 1. Opening & Recorded-Line Disclosure (8) ---------------------------
    item({
      id: "1-1-agent-identification",
      sectionId: "s01-opening",
      name: "1.1 Agent states name, licensed-agent status and company",
      description: "Agent states their full name, licensed-agent status, and company name at call open.",
      citation: MCMG,
      points: 2,
      kind: "required",
      evaluator: "hybrid",
      withinSeconds: 120,
      components: [
        { id: "name", label: "States their name", patterns: ["my name is", "(this|it) is [a-z]+ (with|from|at)", "(im|i am) [a-z]+ (with|from|at)"] },
        { id: "licensed", label: "Licensed agent", patterns: ["licensed (health |medicare |insurance |sales )*(agent|broker|representative|advisor|specialist)"] },
        { id: "company", label: "Company name", patterns: ["insure ?it ?all", "(with|from|at|calling from|on behalf of) iia"] },
      ],
      guidance: "All three must be stated at the open. The company may be named differently from InsureItAll; a clearly stated agency name counts.",
      hint: "Open with your full name, that you are a licensed agent, and the company name.",
    }),
    autoFail({
      id: "1-2-recorded-line",
      sectionId: "s01-opening",
      name: "1.2 Recorded-line disclosure before substantive discussion",
      description: "Agent discloses the call is on a recorded line before any substantive discussion begins.",
      citation: RECORDING_RULE,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      patterns: [...RECORDING_PATTERNS, "on a recorded line"],
      mustPrecede: PLAN_SPECIFIC_PATTERNS,
      guidance: "Fail if the recording disclosure is missing or only comes after Medicare benefits were discussed.",
      hint: "Say the call is on a recorded line before discussing anything substantive.",
      autoFailNote: `${FAIL} Agent failed to disclose that the call was recorded prior to substantive discussion, in violation of CMS call-recording disclosure requirements. ${EXCLUDED}`,
    }),
    autoFail({
      id: "1-3-decision-maker",
      sectionId: "s01-opening",
      name: "1.3 Beneficiary makes own healthcare decisions (or POA engaged)",
      description:
        "Agent confirms the beneficiary makes their own healthcare decisions; if not, engages the POA / authorized representative or reschedules.",
      citation: `${MCMG} beneficiary-protection standards; state elder-protection requirements`,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      patterns: [
        "(make|making|makes) (all )?(your|their|his|her) own (healthcare|health care|medical) decisions",
        "own (healthcare|health care|medical) decisions",
        "power of attorney",
        "\\bpoa\\b",
        "authorized representative",
      ],
      guidance:
        "Pass if the agent asks whether the beneficiary makes their own healthcare decisions and, if the answer is no, brings in an authorized representative / POA or reschedules. Fail if the question is never asked, or the call continues without a representative after a 'no'.",
      hint: "Ask whether they make their own healthcare decisions; involve the POA or reschedule if not.",
      autoFailNote: `${FAIL} Agent proceeded with a beneficiary lacking decision-making capacity without engaging an authorized representative. Call excluded from submission; escalated to Compliance for beneficiary-protection review.`,
    }),

    // ---- 2. TPMO Disclosure, Callback Consent & Non-Affiliation (20) ---------
    autoFail({
      id: "2-1-tpmo-verbatim",
      sectionId: "s02-tpmo",
      name: "2.1 TPMO disclaimer read verbatim with accurate counts",
      description: "TPMO disclaimer read verbatim with an accurate count of the organizations and products represented.",
      citation: TPMO_RULE,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      components: TPMO_COMPONENTS.filter((k) => k.id !== "all_options"),
      guidance: "Both elements must be stated: we do not offer every plan in your area, and how many organizations / plans we represent. A materially altered disclaimer fails.",
      hint: "Read the TPMO disclaimer word for word, including the number of organizations and plans.",
      autoFailNote: `${FAIL} Required TPMO disclaimer was missing, inaccurate, or untimely, in violation of CMS TPMO disclosure requirements. ${EXCLUDED}`,
    }),
    autoFail({
      id: "2-2-tpmo-timing",
      sectionId: "s02-tpmo",
      name: "2.2 TPMO disclaimer before any plan-specific discussion",
      description: "TPMO disclaimer delivered before any plan-specific benefits or eligibility discussion.",
      citation: TPMO_RULE,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      components: TPMO_COMPONENTS.filter((k) => k.id !== "all_options"),
      mustPrecede: PLAN_SPECIFIC_PATTERNS,
      guidance: "Fail if plan-specific benefits or eligibility were discussed before the disclaimer was read.",
      hint: "Read the TPMO disclaimer before talking about any specific plan.",
      autoFailNote: `${FAIL} Required TPMO disclaimer was missing, inaccurate, or untimely, in violation of CMS TPMO disclosure requirements. ${EXCLUDED}`,
    }),
    item({
      id: "2-3-tpmo-all-options",
      sectionId: "s02-tpmo",
      name: "2.3 Medicare.gov, 1-800-MEDICARE and local SHIP referral",
      description: "The disclaimer refers the beneficiary to Medicare.gov, 1-800-MEDICARE, and the local SHIP.",
      citation: TPMO_RULE,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      components: [
        { id: "medicare_gov", label: "Medicare.gov", patterns: ["medicare (dot )?gov"] },
        { id: "phone", label: "1-800-MEDICARE", patterns: ["(1 )?800 medicare", "1800 medicare", "one (eight hundred|800) medicare"] },
        { id: "ship", label: "Local SHIP", patterns: ["state health insurance( assistance)? program", "local ship", "\\bship\\b"] },
      ],
      hint: "Refer them to Medicare.gov, 1-800-MEDICARE and the local SHIP.",
    }),
    item({
      id: "2-4-callback-permission",
      sectionId: "s02-tpmo",
      name: "2.4 Callback number captured and permission to call back confirmed",
      description: "Callback number captured and the beneficiary's permission to call back explicitly confirmed.",
      citation: "IIA 2026 script — TPMO Disclosure",
      points: 5,
      kind: "required",
      evaluator: "hybrid",
      components: [
        {
          id: "number",
          label: "Callback number captured",
          patterns: ["(best|good|callback|call back) (phone )?number", "number (to|i can|we can) (call|reach)", "if (we|the call) (get|gets|happen to get) disconnected"],
        },
        {
          id: "permission",
          label: "Permission to call back",
          patterns: ["permission to (call|contact|reach) you", "(ok|okay|alright) (if|for me to) (i )?call you back", "(may|can) i call you back"],
        },
      ],
      hint: "Get a callback number and ask: “I do have your permission to call you back, correct?”",
    }),
    autoFail({
      id: "2-5-not-affiliated",
      sectionId: "s02-tpmo",
      name: "2.5 Not affiliated with Medicare or the federal government",
      description: "Agent states clearly that the agent/agency is not affiliated with Medicare or the federal government.",
      citation: `${MCMG}: prohibition on implying government affiliation or endorsement`,
      points: 4,
      kind: "required",
      evaluator: "hybrid",
      patterns: [
        "not (affiliated|connected|associated) with (medicare|the (federal )?government|any government)",
        "not (a |an )?(government|federal) (agency|entity|program)",
      ],
      hint: "Say: “We are not affiliated with Medicare or the federal government.”",
      autoFailNote: `${FAIL} Agent failed to disclose non-affiliation with Medicare/the federal government, risking beneficiary confusion about government endorsement. ${EXCLUDED}`,
    }),
    item({
      id: "2-6-multiple-carriers",
      sectionId: "s02-tpmo",
      name: "2.6 Represents multiple carriers, not a government entity",
      description: "Agent clarifies they represent multiple Medicare Advantage carriers/plans, not a government entity.",
      citation: "IIA 2026 script — TPMO Disclosure",
      points: 2,
      kind: "required",
      evaluator: "hybrid",
      patterns: [
        "(represent|work with|contracted with|contract with|appointed with) (multiple|several|many|different|a number of|various) (insurance )?(carriers|companies|insurance companies|plans|organizations)",
      ],
      hint: "Explain that you represent several Medicare Advantage carriers.",
    }),

    // ---- 3. Eligibility & Prior-Coverage Screening (3) -----------------------
    item({
      id: "3-1-current-coverage",
      sectionId: "s03-eligibility",
      name: "3.1 Current coverage screened",
      description: "Agent confirms current coverage status: Medicaid, employer/retiree, Medicare Supplement, VA/Tricare/ChampVA.",
      citation: "IIA 2026 script — screening questions",
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      components: [
        { id: "medicaid", label: "Medicaid", patterns: ["medicaid"] },
        { id: "employer", label: "Employer / retiree coverage", patterns: ["employer", "retiree", "union (coverage|plan)"] },
        { id: "supplement", label: "Medicare Supplement", patterns: ["(medicare )?supplement", "medigap"] },
        { id: "military", label: "VA / Tricare / ChampVA", patterns: ["\\bva\\b", "veterans", "tricare", "champ ?va"] },
      ],
      hint: "Ask about Medicaid, employer/retiree coverage, a Medicare Supplement, and VA/Tricare/ChampVA.",
    }),

    // ---- 4. Client Identity Verification (3) ---------------------------------
    item({
      id: "4-1-identity",
      sectionId: "s04-identity",
      name: "4.1 Beneficiary identity verified",
      description: "Beneficiary identity accurately verified and recorded (MBI, or name/date of birth/ZIP if the card is unavailable).",
      citation: "IIA 2026 script — Client Info",
      points: 3,
      kind: "required",
      evaluator: "llm",
      guidance: "Judge only that the agent verified identity (MBI, or name + date of birth + ZIP). Identifiers are redacted in the transcript; do not repeat them.",
      hint: "Verify identity with the MBI, or name, date of birth and ZIP.",
    }),

    // ---- 5. Scope of Appointment (15) ----------------------------------------
    autoFail({
      id: "5-1-soa-products",
      sectionId: "s05-soa",
      name: "5.1 SOA read verbatim, listing every product type",
      description: "Scope of Appointment read verbatim, listing every product type to be discussed (MA, PDP, Medicare Supplement, ancillary).",
      citation: SOA_RULE,
      points: 5,
      kind: "required",
      evaluator: "hybrid",
      components: [
        { id: "soa", label: "Scope of appointment", patterns: ["scope of (the )?appointment", "\\bsoa\\b", "s o a"] },
        { id: "products", label: "Product types listed", patterns: ["medicare advantage", "prescription drug plan", "part d", "medicare supplement", "medigap", "dental vision", "ancillary"] },
      ],
      mustPrecede: PLAN_SPECIFIC_PATTERNS,
      guidance: "Pass only if the SOA is read before plans are discussed and every product type to be discussed is named. Products discussed outside the agreed scope fail this item.",
      hint: "Read the Scope of Appointment, naming every product type, before discussing plans.",
      autoFailNote: `${FAIL} Agent proceeded without a valid Scope of Appointment or discussed products outside the agreed scope. ${EXCLUDED}`,
    }),
    autoFail({
      id: "5-2-soa-no-obligation",
      sectionId: "s05-soa",
      name: "5.2 No obligation, status unaffected, no automatic enrollment",
      description: "States there is no obligation to enroll, current or future enrollment status is unaffected, and there is no automatic enrollment.",
      citation: SOA_RULE,
      points: 4,
      kind: "required",
      evaluator: "hybrid",
      components: [
        { id: "no_obligation", label: "No obligation to enroll", patterns: ["no obligation", "(not|arent|are not) obligated", "(dont|do not) have to enroll"] },
        {
          id: "status_unaffected",
          label: "Enrollment status unaffected",
          patterns: ["(current|future) (or (current|future) )?(medicare )?enrollment", "(will not|wont|does not|doesnt) (affect|change|impact) your (current|existing)"],
        },
        { id: "no_automatic", label: "No automatic enrollment", patterns: ["automatic(ally)? enroll", "not (be )?automatically"] },
      ],
      hint: "Say there is no obligation, their enrollment status is unaffected, and nothing enrolls them automatically.",
      autoFailNote: `${FAIL} Agent proceeded without a valid Scope of Appointment or discussed products outside the agreed scope. ${EXCLUDED}`,
    }),
    item({
      id: "5-3-soa-agent-datetime",
      sectionId: "s05-soa",
      name: "5.3 Agent name, title, company and date/time in the SOA",
      description: "Agent name, title, company, and the current date and time (local time zone) are disclosed within the SOA.",
      citation: SOA_RULE,
      points: 3,
      kind: "required",
      evaluator: "llm",
      hint: "State your name, title, company and today's date and time in the SOA.",
    }),
    autoFail({
      id: "5-4-soa-permission",
      sectionId: "s05-soa",
      name: "5.4 Explicit permission to continue",
      description: "Beneficiary's explicit permission to continue is obtained before proceeding.",
      citation: SOA_RULE,
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      patterns: [
        "(do i have|have i got|may i have|can i have|i have) your permission to (continue|proceed|go on|move forward|go ahead)",
        "(is it|is that) (ok|okay|alright) (if|to) (we|i) (continue|proceed|go on)",
      ],
      guidance: "The beneficiary must clearly agree. Fail if the agent asks but proceeds without a yes.",
      hint: "Ask: “Do I have your permission to continue?” and wait for a yes.",
      autoFailNote: `${FAIL} Agent proceeded without a valid Scope of Appointment or discussed products outside the agreed scope. ${EXCLUDED}`,
    }),

    // ---- 6. Provider & Prescription Coverage Verification (6) ----------------
    item({
      id: "6-1-provider-network",
      sectionId: "s06-coverage",
      name: "6.1 PCP, specialist and hospital network status verified",
      description: "Verifies PCP, specialist and hospital network status accurately against the plan being reviewed.",
      citation: "IIA 2026 script — PCP/specialist verification",
      points: 3,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no specific plan was reviewed on the call.",
      hint: "Check each doctor and hospital against the plan's network.",
    }),
    item({
      id: "6-2-pharmacy-formulary",
      sectionId: "s06-coverage",
      name: "6.2 Pharmacy network and formulary verified",
      description: "Confirms pharmacy network status and formulary coverage for the beneficiary's medications.",
      citation: "IIA 2026 script — prescription verification",
      points: 3,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no specific plan was reviewed or the beneficiary takes no medications. Do not name or comment on the medications.",
      hint: "Verify the pharmacy and how each prescription is covered.",
    }),

    // ---- 7. Election Period / SEP Validation (10) ----------------------------
    autoFail({
      id: "7-1-election-period",
      sectionId: "s07-election",
      name: "7.1 AEP/OEP window identified or full SEP question set asked",
      description: "Correctly identifies the AEP/OEP window, or asks the full SEP-qualifying question set, before proceeding.",
      citation: "42 CFR 422.62 and 423.38 (enrollment periods)",
      points: 5,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: `Applies once the call moves toward plan discussion or enrollment. ${ENROLLMENT_ONLY.replace("an enrollment or application", "plan discussion or enrollment")}`,
      hint: "Identify the election period (AEP/OEP) or ask the full SEP question set.",
      autoFailNote: `${FAIL} Enrollment was pursued without a valid, documented election period. Call excluded from submission; escalated to Compliance for potential CMS reporting.`,
    }),
    autoFail({
      id: "7-2-valid-election-confirmed",
      sectionId: "s07-election",
      name: "7.2 Valid election period confirmed before plan discussion or enrollment",
      description: "Confirms a valid election period exists before any plan discussion or enrollment proceeds.",
      citation: "42 CFR 422.62 and 423.38 (enrollment periods)",
      points: 3,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: `Fail if plans were discussed or enrollment began before a valid election period was established. ${ENROLLMENT_ONLY.replace("an enrollment or application", "plan discussion or enrollment")}`,
      hint: "Confirm a valid election period before discussing plans or enrolling.",
      autoFailNote: `${FAIL} Enrollment was pursued without a valid, documented election period. Call excluded from submission; escalated to Compliance for potential CMS reporting.`,
    }),
    item({
      id: "7-3-sep-documented",
      sectionId: "s07-election",
      name: "7.3 SEP code / rationale documented",
      description: "Accurately documents the SEP code or rationale supporting the enrollment.",
      citation: "IIA 2026 script — SEP Code",
      points: 2,
      kind: "required",
      evaluator: "llm",
      guidance: "Mark na if the enrollment used AEP/OEP rather than an SEP, or no enrollment occurred.",
      hint: "State and document the SEP code and why it applies.",
    }),

    // ---- 8. Plan Review Checklist & SNP Eligibility Verification (12) --------
    autoFail({
      id: "8-1-csnp-disclosure",
      sectionId: "s08-plan-review",
      name: "8.1 C-SNP chronic-condition and physician-verification disclosure",
      description: "Chronic-condition qualification and the mandatory Physician Verification requirement are disclosed (C-SNP).",
      citation: "42 CFR 422.2 (SNP definitions); CMS SNP eligibility verification guidance",
      points: 4,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance:
        'Applies only when a Chronic-condition SNP (C-SNP) is discussed or enrolled. Otherwise return "na" and quote the words naming the plan type (e.g. "a PPO plan"). Do not assess or name the beneficiary\'s conditions.',
      hint: "For a C-SNP, explain the chronic-condition requirement and the physician verification.",
      autoFailNote: `${FAIL} Required SNP eligibility verification disclosure was omitted for an applicable Special Needs Plan enrollment. ${EXCLUDED}`,
    }),
    autoFail({
      id: "8-2-dsnp-disclosure",
      sectionId: "s08-plan-review",
      name: "8.2 D-SNP dual-eligibility verification disclosure",
      description: "Dual-eligibility (Medicare + Medicaid) verification requirement is disclosed (D-SNP).",
      citation: "42 CFR 422.2 (SNP definitions); CMS SNP eligibility verification guidance",
      points: 4,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: 'Applies only when a Dual-eligible SNP (D-SNP) is discussed or enrolled. Otherwise return "na" and quote the words naming the plan type.',
      hint: "For a D-SNP, explain that Medicare + Medicaid eligibility will be verified.",
      autoFailNote: `${FAIL} Required SNP eligibility verification disclosure was omitted for an applicable Special Needs Plan enrollment. ${EXCLUDED}`,
    }),
    item({
      id: "8-3-plan-review-checklist",
      sectionId: "s08-plan-review",
      name: "8.3 Plan Review Checklist covered completely and accurately",
      description: "Reviews all applicable Plan Review Checklist categories completely and accurately (premium, deductible, MOOP, extra benefits, etc.).",
      citation: "IIA 2026 script — Plan Review Checklist",
      points: 4,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no specific plan was reviewed. Partial credit if some categories were omitted.",
      hint: "Walk through premium, deductible, MOOP and extra benefits for the plan.",
    }),

    // ---- 9. Mandatory Pre-Enrollment Checklist (7) ---------------------------
    autoFail({
      id: "9-1-plan-type-explained",
      sectionId: "s09-pre-enrollment",
      name: "9.1 HMO / HMO-POS / PPO / PFFS explanation matches the plan sold",
      description: "The plan-type explanation (HMO, HMO-POS, PPO, PFFS) matches the actual plan type being sold.",
      citation: "CMS Mandatory Pre-Enrollment Checklist; 42 CFR 422.2262",
      points: 4,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: ENROLLMENT_ONLY,
      hint: "Explain how the plan's network type (HMO/PPO/…) works, accurately.",
      autoFailNote: `${FAIL} Plan-type explanation did not match the plan being enrolled, and/or required SNP disclaimers were not reiterated at enrollment, risking beneficiary misunderstanding of plan structure or eligibility. ${EXCLUDED}`,
    }),
    autoFail({
      id: "9-2-snp-reiterated",
      sectionId: "s09-pre-enrollment",
      name: "9.2 SNP eligibility disclaimers reiterated at enrollment",
      description: "SNP-specific eligibility disclaimers are reiterated at the point of enrollment when applicable.",
      citation: "CMS SNP eligibility verification guidance",
      points: 3,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: 'Applies only to a C-SNP or D-SNP enrollment. Otherwise return "na" and quote the words naming the plan type, or showing no enrollment happened.',
      hint: "Repeat the SNP eligibility disclaimer at the point of enrollment.",
      autoFailNote: `${FAIL} Plan-type explanation did not match the plan being enrolled, and/or required SNP disclaimers were not reiterated at enrollment, risking beneficiary misunderstanding of plan structure or eligibility. ${EXCLUDED}`,
    }),

    // ---- 10. Priorities Recap (2) -------------------------------------------
    item({
      id: "10-1-priorities-recap",
      sectionId: "s10-priorities",
      name: "10.1 Recommendation matches stated priorities",
      description: "The final plan recommendation matches the beneficiary's stated priorities (needs recap accurately reflected).",
      citation: "IIA 2026 script — Priorities Recap",
      points: 2,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if no recommendation was made.",
      hint: "Recap their priorities and tie the recommendation to them.",
    }),

    // ---- 11. Pre-Enrollment Disclosure (13) ----------------------------------
    autoFail({
      id: "11-1-pre-enrollment-disclosures",
      sectionId: "s11-disclosure",
      name: "11.1 All required pre-enrollment disclosures read verbatim",
      description:
        "All required pre-enrollment disclosure elements read completely, accurately and verbatim: IRMAA, late-enrollment penalty, contract renewal, one plan at a time, Part A/B requirement, data sharing, voluntary response, false-information warning, cancellation rights, complaint/SHIP rights, employer-coverage impact, out-of-country coverage, EOC access.",
      citation: "CMS Medicare Enrollment and Disenrollment Guidance; 42 CFR 422.60 et seq.",
      points: 10,
      kind: "required",
      evaluator: "hybrid",
      conditional: true,
      components: [
        { id: "irmaa", label: "IRMAA", patterns: ["irmaa", "income related monthly adjustment"] },
        { id: "late_penalty", label: "Late-enrollment penalty", patterns: ["late enrollment penalty", "late penalty"] },
        { id: "renewal", label: "Contract renewal", patterns: ["(contract|plan) (is |may |may not |will )?(be )?renew", "renews? (each|every) year"] },
        { id: "one_plan", label: "One plan at a time", patterns: ["one (medicare )?(advantage )?plan at a time", "only (be )?(enrolled )?in one"] },
        { id: "part_ab", label: "Part A and B requirement", patterns: ["part a and (part )?b"] },
        { id: "data_sharing", label: "Data sharing", patterns: ["(share|sharing|release|releasing|disclose) (your |this )?(information|data)"] },
        { id: "voluntary", label: "Voluntary response", patterns: ["voluntary", "(not|dont|do not) have to (answer|respond)"] },
        { id: "false_info", label: "False-information warning", patterns: ["false (information|statements?)", "(misleading|fraudulent) (information|statements?)"] },
        { id: "cancellation", label: "Cancellation rights", patterns: ["cancel (your |this |the )?(enrollment|application)", "cancellation"] },
        { id: "complaint", label: "Complaint / SHIP rights", patterns: ["complaint", "grievance"] },
        { id: "employer", label: "Employer-coverage impact", patterns: ["employer (or union )?(coverage|plan|benefits)", "retiree (coverage|plan|benefits)"] },
        { id: "out_of_country", label: "Out-of-country coverage", patterns: ["outside (of )?the (us|united states|country)", "out of (the )?country"] },
        { id: "eoc", label: "Evidence of Coverage access", patterns: ["evidence of coverage", "\\beoc\\b"] },
      ],
      guidance: `Every element must be delivered completely and accurately; an omitted, shortened or materially altered element fails. ${ENROLLMENT_ONLY}`,
      hint: "Read every pre-enrollment disclosure in full, word for word.",
      autoFailNote: `${FAIL} One or more mandatory CMS pre-enrollment disclosures were omitted or materially altered. ${EXCLUDED}`,
    }),
    item({
      id: "11-2-questions-opportunity",
      sectionId: "s11-disclosure",
      name: "11.2 Unhurried chance to ask questions and confirm understanding",
      description: "Beneficiary is given a clear, unhurried opportunity to ask questions and confirm understanding before proceeding.",
      citation: "IIA 2026 script — “stop me if anything sounds off”",
      points: 3,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if the call did not reach the pre-enrollment disclosures.",
      hint: "Pause, invite questions, and confirm understanding before moving on.",
    }),

    // ---- 12. Enrollment Application & Recorded Consent (12) ------------------
    autoFail({
      id: "12-1-recorded-consent",
      sectionId: "s12-consent",
      name: "12.1 Recorded consent before the enrollment application",
      description: "Explicit recorded consent is obtained before the enrollment application begins.",
      citation: `${RECORDING_RULE}, as applied to the enrollment application`,
      points: 5,
      kind: "required",
      evaluator: "hybrid",
      conditional: true,
      patterns: [
        "permission to record (this|the|your) (enrollment|application)",
        "(ok|okay|alright) (if|to|for me to) (i |we )?record (this|the|your) (enrollment|application)",
      ],
      guidance: `The beneficiary must agree before the application starts. ${ENROLLMENT_ONLY}`,
      hint: "Ask: “Do I have your permission to record this enrollment?” before starting the application.",
      autoFailNote: `${FAIL} Enrollment application was started without explicit recorded consent from the beneficiary. ${EXCLUDED}`,
    }),
    autoFail({
      id: "12-2-enrollment-confirmation",
      sectionId: "s12-consent",
      name: "12.2 Intent to enroll, exact premium and effective date confirmed",
      description: "Confirms the intent to enroll, the exact premium amount, and the proposed effective date, verbatim.",
      citation: "CMS mandatory enrollment confirmation and disclosure requirements",
      points: 4,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: `All three must be confirmed: intent to enroll, exact premium, effective date. ${ENROLLMENT_ONLY}`,
      hint: "Confirm their intent to enroll, the exact premium and the effective date.",
      autoFailNote: `${FAIL} Required enrollment confirmation elements (intent, premium, effective date, and/or plan-type understanding) were not obtained. ${EXCLUDED}`,
    }),
    autoFail({
      id: "12-3-ma-not-supplement",
      sectionId: "s12-consent",
      name: "12.3 Understands the plan is Medicare Advantage, not a Supplement",
      description: "Confirms the beneficiary understands the plan is Medicare Advantage, not a Medicare Supplement.",
      citation: "CMS mandatory enrollment confirmation and disclosure requirements",
      points: 3,
      kind: "required",
      evaluator: "hybrid",
      conditional: true,
      patterns: ["not a (medicare )?supplement", "not (a )?medigap", "medicare advantage (plan )?(and|not|rather than|instead of) (a )?(medicare )?supplement"],
      guidance: `The agent must confirm it with the beneficiary, not just mention it. ${ENROLLMENT_ONLY}`,
      hint: "Confirm: “This is a Medicare Advantage plan, not a Medicare Supplement plan — correct?”",
      autoFailNote: `${FAIL} Required enrollment confirmation elements (intent, premium, effective date, and/or plan-type understanding) were not obtained. ${EXCLUDED}`,
    }),

    // ---- 13. Benefits Review, Government & TPMO Restatement (2) --------------
    autoFail({
      id: "13-1-government-restated",
      sectionId: "s13-restatement",
      name: "13.1 “Not a government agency” repeated in the enrollment disclosures",
      description: "The “<Agency name> is not a government agency” disclosure is repeated in the enrollment / SunFire benefits review.",
      citation: `${MCMG}: prohibition on implying government affiliation or endorsement`,
      points: 2,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance: `This is the RESTATEMENT during the enrollment benefits review, separate from the opening TPMO statement; the opening statement alone does not pass this item. ${ENROLLMENT_ONLY}`,
      hint: "Repeat “we are not a government agency” during the enrollment benefits review.",
      autoFailNote: `${FAIL} Agent failed to disclose non-affiliation with Medicare/the federal government, risking beneficiary confusion about government endorsement. ${EXCLUDED}`,
    }),

    // ---- 14. Applicant & Contact Information (3) -----------------------------
    item({
      id: "14-1-contact-info",
      sectionId: "s14-contact",
      name: "14.1 Contact info, address and language preference confirmed",
      description: "Contact information, residential address and language preference are confirmed and accurately captured.",
      citation: "IIA 2026 script — Applicant & Contact Information",
      points: 3,
      kind: "required",
      evaluator: "llm",
      guidance: `${ENROLLMENT_ONLY} Do not repeat the contact details.`,
      hint: "Confirm phone, residential address and language preference.",
    }),

    // ---- 15. HRA Completion & Welcome Packet (2) -----------------------------
    item({
      id: "15-1-welcome-packet",
      sectionId: "s15-hra",
      name: "15.1 Welcome packet timing, effective date and next steps",
      description: "Welcome packet timing, the effective date and next steps are explained accurately.",
      citation: "IIA 2026 script — HRA Completion",
      points: 2,
      kind: "required",
      evaluator: "llm",
      guidance: ENROLLMENT_ONLY,
      hint: "Explain when the welcome packet arrives, the effective date and what happens next.",
    }),

    // ---- 16. Extra Help Program & Personal Security Code (4) -----------------
    item({
      id: "16-1-security-code",
      sectionId: "s16-extra-help",
      name: "16.1 Personal security code issued with anti-fraud explanation",
      description: "A personal security code is issued with a clear anti-fraud explanation of its purpose.",
      citation: "IIA 2026 script — Personal Security Code",
      points: 3,
      kind: "required",
      evaluator: "llm",
      guidance: `${ENROLLMENT_ONLY} Do not repeat the code.`,
      hint: "Give the personal security code and explain it protects them from fraud.",
    }),
    item({
      id: "16-2-extra-help",
      sectionId: "s16-extra-help",
      name: "16.2 Part D Extra Help (LIS) mentioned when it may apply",
      description: "Part D Extra Help (Low-Income Subsidy) is mentioned when the beneficiary's profile suggests possible eligibility.",
      citation: "IIA 2026 script — Extra Help Program",
      points: 1,
      kind: "judgment",
      evaluator: "llm",
      guidance: "Mark na if nothing in the call suggests possible Extra Help eligibility. Do not speculate about the beneficiary's income.",
      hint: "Mention Extra Help when they may qualify.",
    }),

    // ---- 17. Customer Satisfaction Team Disclosures (2) ----------------------
    item({
      id: "17-1-satisfaction-team",
      sectionId: "s17-satisfaction",
      name: "17.1 Customer Satisfaction Team / servicing model presented",
      description: "Customer Satisfaction Team and servicing-model disclosures are accurately presented.",
      citation: "IIA 2026 script — InsureItAll Customer Satisfaction Team",
      points: 2,
      kind: "required",
      evaluator: "llm",
      guidance: ENROLLMENT_ONLY,
      hint: "Explain the Customer Satisfaction Team and how they will be serviced.",
    }),

    // ---- 18. Call Closing, Wrap-Up & TPV (5) ---------------------------------
    item({
      id: "18-1-sequence",
      sectionId: "s18-closing",
      name: "18.1 All mandatory script sections completed in order",
      description: "All mandatory script sections are completed in the correct sequence (assessed at the close).",
      citation: "IIA 2026 script — entire call",
      points: 2,
      kind: "judgment",
      evaluator: "llm",
      hint: "Follow the script sections in order.",
    }),
    autoFail({
      id: "18-2-tpv",
      sectionId: "s18-closing",
      name: "18.2 Third-Party Verification completed when required",
      description: "Third-Party Verification (TPV) is completed when required by the carrier or state.",
      citation: "Carrier- and state-specific TPV requirements",
      points: 2,
      kind: "required",
      evaluator: "llm",
      conditional: true,
      guidance:
        'Applies only when this carrier/state requires TPV for an enrollment on this call. If TPV was not required or no enrollment happened, return "na" and quote the words that show it.',
      hint: "Complete the Third-Party Verification when the carrier or state requires it.",
      autoFailNote: `${FAIL} Mandatory Third-Party Verification was not completed. ${EXCLUDED}`,
    }),
    item({
      id: "18-3-wrap-up",
      sectionId: "s18-closing",
      name: "18.3 Required warm-transfer / next-step disclosures at close",
      description: "The call closes with all required warm-transfer and next-step disclosures delivered.",
      citation: "IIA 2026 script — Wrap Up (Required)",
      points: 1,
      kind: "required",
      evaluator: "llm",
      hint: "Close with the required warm-transfer and next-step disclosures.",
    }),

    // ---- 19. Compliance Conduct Standards (21) — whole call -----------------
    autoFail({
      id: "19-1-no-misrepresentation",
      sectionId: "s19-conduct",
      name: "19.1 No misrepresentation of benefits, costs, network or eligibility",
      description: "No misrepresentation of plan benefits, costs, provider network or eligibility at any point in the call.",
      citation: MARKETING_RULE,
      points: 5,
      kind: "prohibited",
      evaluator: "llm",
      guidance: "Fail only with a quoted statement that misstates benefits, costs, network status or eligibility.",
      hint: "Describe benefits, costs, networks and eligibility exactly as the plan documents state.",
      autoFailNote: `${FAIL} Agent misrepresented plan benefits, costs, network status, or eligibility. Call excluded from submission; escalated to Compliance for immediate review and possible disciplinary action.`,
    }),
    autoFail({
      id: "19-2-no-pressure",
      sectionId: "s19-conduct",
      name: "19.2 No high-pressure tactics, steering or discouraging comparison",
      description: "No high-pressure tactics, steering, or discouraging the beneficiary from comparing other plans or using SHIP resources.",
      citation: `${MARKETING_RULE}; MCMG prohibition on high-pressure and scare tactics`,
      points: 5,
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [...PRESSURE_PATTERNS, "(dont|do not|no need to) (bother )?(call|calling|contact) (medicare|ship|the ship)", "(dont|do not) (need to )?(shop|compare) (around|other plans)"],
      guidance: "Accurately stating a real enrollment deadline is allowed.",
      hint: "No pressure or steering; encourage them to compare and use SHIP if they want.",
      autoFailNote: `${FAIL} Agent used high-pressure or steering tactics inconsistent with CMS marketing conduct standards. ${EXCLUDED}`,
    }),
    autoFail({
      id: "19-3-health-info-minimum",
      sectionId: "s19-conduct",
      name: "19.3 No health information beyond what eligibility requires",
      description: "No collection or use of health information beyond what is necessary to determine plan eligibility.",
      citation: "HIPAA Privacy Rule; CMS PHI-minimization guidance for TPMOs",
      points: 3,
      kind: "prohibited",
      evaluator: "llm",
      guidance:
        "Fail only when the agent asks for or uses health details not needed for eligibility (e.g. probing diagnoses outside a C-SNP qualification). Quote the agent's question, never the beneficiary's health details.",
      hint: "Only ask health questions needed to determine eligibility.",
      autoFailNote: `${FAIL} Agent collected or used health information beyond what was necessary for eligibility determination. Call excluded from submission; escalated to Compliance and Privacy Office.`,
    }),
    autoFail({
      id: "19-4-no-inducements",
      sectionId: "s19-conduct",
      name: "19.4 No unapproved gifts, meals or incentives",
      description: "No unapproved gifts, meals or incentives offered or implied to induce enrollment.",
      citation: "42 CFR 422.2264(b) (nominal gift limits); MCMG",
      points: 2,
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [
        "gift cards?",
        "free (gift|meal|lunch|dinner|breakfast)",
        "(well|ill|we will|i will|we can|i can) (send|give|mail) you (a |an )?(gift|reward|bonus|cash|check)",
        "(bonus|reward|cash) (for|if you) (enrolling|signing up|enroll|sign up)",
      ],
      hint: "Never offer or imply a gift or incentive to enroll.",
      autoFailNote: `${FAIL} Agent offered or implied a prohibited inducement to enroll. ${EXCLUDED}`,
    }),
    item({
      id: "19-5-verbatim",
      sectionId: "s19-conduct",
      name: "19.5 Verbatim (red-text) language delivered as scripted",
      description: "Verbatim (red-text) script language is delivered exactly as scripted, with no unauthorized substitutions.",
      citation: "IIA 2026 script key — red text is verbatim",
      points: 3,
      kind: "judgment",
      evaluator: "llm",
      hint: "Read the red-text disclosures word for word.",
    }),
    item({
      id: "19-6-pacing",
      sectionId: "s19-conduct",
      name: "19.6 Clear, respectful, unhurried communication",
      description: "Clear, respectful, unhurried communication paced appropriately to the beneficiary's needs.",
      citation: "IIA 2026 script — entire call",
      points: 2,
      kind: "judgment",
      evaluator: "llm",
      hint: "Slow down and check understanding.",
    }),
    item({
      id: "19-7-no-unapproved-claims",
      sectionId: "s19-conduct",
      name: "19.7 No unapproved marketing claims, guarantees or filler",
      description: "No unapproved marketing claims, guarantees or filler statements introduced outside the script.",
      citation: MARKETING_RULE,
      points: 1,
      kind: "prohibited",
      evaluator: "hybrid",
      patterns: [...SUPERLATIVE_PATTERNS, ...GUARANTEE_PATTERNS],
      guidance: "'Guaranteed issue' and 'guaranteed renewable' are legitimate terms. Substantiated star ratings are allowed.",
      hint: "Stick to the script: no 'best plan' or guarantee claims.",
    }),
  ],
};
