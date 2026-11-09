/**
 * Turns the raw CMS Plan Benefit Package (PBP) columns of one plan into the
 * handful of plain-English facts a plan card shows.
 *
 * Input is the plan's rows from `cms_plan_benefit_sections`, keyed by section
 * name. Output never guesses: a field that cannot be read with confidence is
 * `null`, and the card shows "See plan details" instead of a made-up number.
 *
 * Column meanings were checked against the CMS PBP 2027 data dictionary and
 * against value distributions across all individual-market plans:
 *   - yes/no columns: "1" = yes, "2" = no ("3" = yes with a minimum and a maximum)
 *   - a service with copay "no" AND coinsurance "no" has no cost share ($0)
 *   - allowance periods: 1 = every 3 years, 2 = every 2 years, 3 = every year,
 *     4 = every 6 months, 5 = every 3 months, 7 = every month, 6 = other
 *   - benefit "type" columns: 2 = mandatory (included), 3 = optional (extra
 *     premium), 4 = both
 *
 * What this data does NOT contain (so a card must never imply it): the Part D
 * (drug plan) premium, star ratings, provider networks, formularies.
 */

export type Row = Record<string, string>;
export type Sections = Record<string, Row[]>;

export interface CostShare {
  /** "none" = no cost share; "unknown" is never returned (null is). */
  kind: "none" | "copay" | "coinsurance" | "mixed";
  /** Display text, e.g. "$0", "$40", "$0–$50", "20%". */
  label: string;
}

export interface Allowance {
  amount: number;
  /** Display text, e.g. "$150 per quarter". */
  label: string;
}

export interface PlanCard {
  /** Plan (Part C) monthly premium. Does NOT include any Part D premium. */
  premium: number | null;
  /** Part B premium the plan pays back each month, if any. */
  partBGiveback: number | null;
  moopInNetwork: number | null;
  /** Combined in- and out-of-network maximum (PPOs). */
  moopCombined: number | null;
  /** Annual medical deductible; 0 when the plan has none. */
  deductible: number | null;
  costs: {
    pcp: CostShare | null;
    specialist: CostShare | null;
    er: CostShare | null;
    urgentCare: CostShare | null;
    /** Inpatient hospital stay, e.g. "$350 per day, days 1–5". */
    hospital: string | null;
  };
  extras: {
    dental: { preventive: boolean; comprehensive: boolean; maximum: string | null };
    vision: { exam: boolean; eyewear: boolean; allowance: string | null };
    hearing: { exam: boolean; aids: boolean; allowance: string | null };
    otc: { offered: boolean; allowance: string | null };
    fitness: boolean;
    meals: boolean;
    transportation: boolean;
  };
  drugs: {
    /** Does the plan include Part D drug coverage? null = not stated. */
    covered: boolean | null;
    /** Drug deductible text, e.g. "$0", "$615", "Standard Part D deductible". */
    deductible: string | null;
  };
}

// ---------------------------------------------------------------------------
// Which raw columns the card reads (the API selects only these).

const DENTAL_PREVENTIVE = ["oe", "dx", "ods", "pc", "ft", "ops"] as const;
const DENTAL_COMPREHENSIVE = ["rs", "end", "peri", "prm", "mxpr", "impl", "prf", "omsg", "orth", "ags"] as const;

const costKeys = (p: string) => [
  `${p}_copay_yn`,
  `${p}_copay_amt_mc_min`,
  `${p}_copay_amt_mc_max`,
  `${p}_coins_yn`,
  `${p}_coins_pct_mc_min`,
  `${p}_coins_pct_mc_max`,
];

export const CARD_COLUMNS: Record<string, string[]> = {
  section_d: [
    "pbp_d_mplusc_premium",
    "pbp_d_mco_pay_reduct_yn",
    "pbp_d_mco_pay_reduct_amt",
    "pbp_d_out_pocket_amt_yn",
    "pbp_d_out_pocket_amt",
    "pbp_d_comb_max_enr_amt_yn",
    "pbp_d_comb_max_enr_amt",
    "pbp_d_ann_deduct_yn",
    "pbp_d_ann_deduct_amt",
  ],
  b7_health_prof: [...costKeys("pbp_b7a"), ...costKeys("pbp_b7d")],
  b4_emerg_urgent: [...costKeys("pbp_b4a"), ...costKeys("pbp_b4b")],
  b1a_inpat_hosp: [
    "pbp_b1a_copay_yn",
    "pbp_b1a_coins_yn",
    "pbp_b1a_cost_vary_tiers_yn",
    "pbp_b1a_copay_mcs_amt_t1",
    ...[1, 2, 3].flatMap((i) => [
      `pbp_b1a_copay_mcs_amt_int${i}_t1`,
      `pbp_b1a_copay_mcs_bgnd_int${i}_t1`,
      `pbp_b1a_copay_mcs_endd_int${i}_t1`,
    ]),
    "pbp_b1a_coins_mcs_pct_t1",
  ],
  b16_dental: [
    ...DENTAL_PREVENTIVE.map((s) => `pbp_b16b_bendesc_${s}_amo`),
    ...DENTAL_COMPREHENSIVE.map((s) => `pbp_b16c_bendesc_${s}_amo`),
    "pbp_b16b_maxplan_pv_yn",
    "pbp_b16b_maxplan_pv_amt",
    "pbp_b16b_maxplan_pv_per",
    "pbp_b16c_maxplan_cmp_yn",
    "pbp_b16c_maxplan_cmp_type",
    "pbp_b16c_maxplan_cmp_amt",
    "pbp_b16c_maxplan_cmp_per",
  ],
  b17_eye_exams_wear: [
    "pbp_b17a_bendesc_yn",
    "pbp_b17b_bendesc_yn",
    "pbp_b17b_comb_maxplan_yn",
    "pbp_b17b_comb_maxplan_amt",
    "pbp_b17b_comb_maxplan_per",
  ],
  b18_hearing_exams_aids: [
    "pbp_b18a_bendesc_yn",
    "pbp_b18b_bendesc_yn",
    "pbp_b18b_maxplan_yn",
    "pbp_b18b_maxplan_amt",
    "pbp_b18b_maxplan_per",
    "pbp_b18b_maxplan_perear",
  ],
  b13_other_services: [
    "pbp_b13b_bendesc_otc",
    "pbp_b13b_maxplan_yn",
    "pbp_b13b_maxplan_amt",
    "pbp_b13b_otc_maxplan_per",
    "pbp_b13c_bendesc_service",
  ],
  b14_preventive: ["pbp_b14c_bendesc_amo_mhc"],
  b10_amb_trans: ["pbp_b10b_bendesc_yn"],
  mrx: ["mrx_drug_ben_yn", "mrx_alt_ded_charge", "mrx_alt_ded_amount"],
};

// ---------------------------------------------------------------------------
// Small readers.

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const first = (sections: Sections, name: string): Row => sections[name]?.[0] ?? {};

/**
 * CMS special-needs plan type codes (pbp_a_special_need_plan_type in
 * pbp_Section_A.txt). Checked against the CMS PBP data dictionary for plan year
 * 2027; re-check this map against the dictionary of any new plan year, because
 * the label decides whether the card shows the Medicaid note.
 */
const SNP_TYPE_LABEL: Record<string, string> = {
  "1": "Institutional",
  "3": "Dual-Eligible",
  "4": "Chronic or Disabling Condition",
};

/** The stored value is a CMS code; an unrecognised value is passed through unchanged. */
export function snpTypeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return SNP_TYPE_LABEL[code] ?? code;
}

export function formatMoney(n: number): string {
  const whole = Number.isInteger(n);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const formatPct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/**
 * A min–max range. With `needBoth` (CMS code 3, "min and max") a missing bound
 * means the range is unknown, so it returns null rather than a single price.
 */
function range(min: number | null, max: number | null, fmt: (n: number) => string, needBoth = false): string | null {
  if (needBoth && (min == null || max == null)) return null;
  const lo = min ?? max;
  const hi = max ?? min;
  if (lo == null || hi == null) return null;
  return lo === hi ? fmt(lo) : `${fmt(Math.min(lo, hi))}–${fmt(Math.max(lo, hi))}`;
}

/**
 * Copay and/or coinsurance for one service, or null when it cannot be read.
 * If CMS says a part applies (copay or coinsurance) but its amount cannot be
 * read, the whole cost is unknown: showing only the readable part would
 * understate what the member pays.
 */
function costShare(row: Row, p: string): CostShare | null {
  const copayYn = row[`${p}_copay_yn`];
  const coinsYn = row[`${p}_coins_yn`];
  const copayApplies = copayYn === "1" || copayYn === "3";
  const coinsApplies = coinsYn === "1" || coinsYn === "3";
  const copay = copayApplies
    ? range(num(row[`${p}_copay_amt_mc_min`]), num(row[`${p}_copay_amt_mc_max`]), formatMoney, copayYn === "3")
    : null;
  const coins = coinsApplies
    ? range(num(row[`${p}_coins_pct_mc_min`]), num(row[`${p}_coins_pct_mc_max`]), formatPct, coinsYn === "3")
    : null;
  if ((copayApplies && !copay) || (coinsApplies && !coins)) return null;
  if (copay && coins) return { kind: "mixed", label: `${copay} or ${coins}` };
  if (copay) return { kind: "copay", label: copay };
  if (coins) return { kind: "coinsurance", label: coins };
  // Said "no" to both: nothing to pay. A "yes" we could not read stays unknown.
  if (copayYn === "2" && coinsYn === "2") return { kind: "none", label: "$0" };
  return null;
}

const PERIOD_LABEL: Record<string, string> = {
  "1": "every 3 years",
  "2": "every 2 years",
  "3": "per year",
  "4": "every 6 months",
  "5": "per quarter",
  "7": "per month",
};

function allowanceLabel(amount: number | null, period: string | undefined): string | null {
  if (amount == null || amount <= 0) return null;
  const per = period ? PERIOD_LABEL[period] : undefined;
  return per ? `${formatMoney(amount)} ${per}` : null;
}

const included = (v: string | undefined) => v === "2" || v === "4";

const applies = (v: string | undefined) => v === "1" || v === "3";

function hospitalStay(row: Row): string | null {
  if (row.pbp_b1a_cost_vary_tiers_yn === "1") return null; // tiered by hospital: too long for a card
  // Copay and coinsurance together is too involved for a card line.
  if (applies(row.pbp_b1a_copay_yn) && applies(row.pbp_b1a_coins_yn)) return null;
  if (row.pbp_b1a_coins_yn === "1") {
    const pct = num(row.pbp_b1a_coins_mcs_pct_t1);
    if (pct != null) return `${formatPct(pct)} of the cost`;
    return null;
  }
  if (row.pbp_b1a_copay_yn === "2") return row.pbp_b1a_coins_yn === "2" ? "$0" : null;
  if (row.pbp_b1a_copay_yn !== "1") return null;
  const parts: string[] = [];
  for (const i of [1, 2, 3]) {
    const amt = num(row[`pbp_b1a_copay_mcs_amt_int${i}_t1`]);
    const from = num(row[`pbp_b1a_copay_mcs_bgnd_int${i}_t1`]);
    const to = num(row[`pbp_b1a_copay_mcs_endd_int${i}_t1`]);
    if (amt == null && from == null && to == null) continue; // interval not used
    if (amt == null || from == null || to == null) return null; // present but unreadable
    const days = from === to ? `day ${from}` : `days ${from}–${to}`;
    parts.push(amt === 0 ? `$0 for ${days}` : `${formatMoney(amt)} per day, ${days}`);
  }
  if (parts.length > 0) return parts.join("; ");
  const flat = num(row.pbp_b1a_copay_mcs_amt_t1);
  return flat != null ? `${formatMoney(flat)} per stay` : null;
}

// ---------------------------------------------------------------------------

export function buildPlanCard(sections: Sections): PlanCard {
  const d = first(sections, "section_d");
  const b7 = first(sections, "b7_health_prof");
  const b4 = first(sections, "b4_emerg_urgent");
  const b16 = first(sections, "b16_dental");
  const b17 = first(sections, "b17_eye_exams_wear");
  const b18 = first(sections, "b18_hearing_exams_aids");
  const b13 = first(sections, "b13_other_services");
  const mrx = first(sections, "mrx");

  const premium = num(d.pbp_d_mplusc_premium);
  const giveback = d.pbp_d_mco_pay_reduct_yn === "1" ? num(d.pbp_d_mco_pay_reduct_amt) : null;

  let deductible: number | null = null;
  if (d.pbp_d_ann_deduct_yn === "2") deductible = 0;
  else if (d.pbp_d_ann_deduct_yn === "1") deductible = num(d.pbp_d_ann_deduct_amt);

  // Dental: a combined limit (type 1) is the preventive limit; otherwise each has its own.
  const preventive = DENTAL_PREVENTIVE.some((s) => included(b16[`pbp_b16b_bendesc_${s}_amo`]));
  const comprehensive = DENTAL_COMPREHENSIVE.some((s) => included(b16[`pbp_b16c_bendesc_${s}_amo`]));
  const pvMax =
    b16.pbp_b16b_maxplan_pv_yn === "1"
      ? allowanceLabel(num(b16.pbp_b16b_maxplan_pv_amt), b16.pbp_b16b_maxplan_pv_per)
      : null;
  const cmpMax =
    b16.pbp_b16c_maxplan_cmp_yn === "1" && b16.pbp_b16c_maxplan_cmp_type === "2"
      ? allowanceLabel(num(b16.pbp_b16c_maxplan_cmp_amt), b16.pbp_b16c_maxplan_cmp_per)
      : null;
  const sharedLimit = b16.pbp_b16c_maxplan_cmp_type === "1";
  let dentalMax: string | null = null;
  if (preventive && comprehensive && sharedLimit && pvMax) dentalMax = `${pvMax} (preventive + comprehensive)`;
  else if (comprehensive && cmpMax && !pvMax) dentalMax = `${cmpMax} (comprehensive)`;
  else if (comprehensive && cmpMax && pvMax) dentalMax = `${pvMax} preventive; ${cmpMax} comprehensive`;
  else if (pvMax && !comprehensive) dentalMax = `${pvMax} (preventive)`;

  const eyewear = b17.pbp_b17b_bendesc_yn === "1";
  const aids = b18.pbp_b18b_bendesc_yn === "1";
  const hearingBase =
    aids && b18.pbp_b18b_maxplan_yn === "1" ? allowanceLabel(num(b18.pbp_b18b_maxplan_amt), b18.pbp_b18b_maxplan_per) : null;
  const hearingAllowance = hearingBase
    ? b18.pbp_b18b_maxplan_perear === "1"
      ? `${hearingBase} per ear`
      : hearingBase
    : null;

  const otcOffered = b13.pbp_b13b_bendesc_otc === "1";

  let drugDeductible: string | null = null;
  if (mrx.mrx_drug_ben_yn === "1") {
    if (mrx.mrx_alt_ded_charge === "3") drugDeductible = "$0";
    else if (mrx.mrx_alt_ded_charge === "2") {
      const a = num(mrx.mrx_alt_ded_amount);
      drugDeductible = a != null ? formatMoney(a) : null;
    } else if (mrx.mrx_alt_ded_charge === "1") drugDeductible = "Standard Part D deductible";
  }

  // The plan has a medical deductible and the file's per-service deductible
  // flags are not read here, so "$0" cannot be told apart from "$0 after the
  // deductible". Show "See details" instead of a $0 that may be wrong.
  const noDeductibleClaim = (c: CostShare | null): CostShare | null =>
    c?.kind === "none" && deductible != null && deductible > 0 ? null : c;

  return {
    premium,
    partBGiveback: giveback != null && giveback > 0 ? giveback : null,
    moopInNetwork: d.pbp_d_out_pocket_amt_yn === "1" ? num(d.pbp_d_out_pocket_amt) : null,
    moopCombined: d.pbp_d_comb_max_enr_amt_yn === "1" ? num(d.pbp_d_comb_max_enr_amt) : null,
    deductible,
    costs: {
      pcp: noDeductibleClaim(costShare(b7, "pbp_b7a")),
      specialist: noDeductibleClaim(costShare(b7, "pbp_b7d")),
      er: noDeductibleClaim(costShare(b4, "pbp_b4a")),
      urgentCare: noDeductibleClaim(costShare(b4, "pbp_b4b")),
      hospital: hospitalStay(first(sections, "b1a_inpat_hosp")),
    },
    extras: {
      dental: { preventive, comprehensive, maximum: dentalMax },
      vision: {
        exam: b17.pbp_b17a_bendesc_yn === "1",
        eyewear,
        allowance:
          eyewear && b17.pbp_b17b_comb_maxplan_yn === "1"
            ? allowanceLabel(num(b17.pbp_b17b_comb_maxplan_amt), b17.pbp_b17b_comb_maxplan_per)
            : null,
      },
      hearing: { exam: b18.pbp_b18a_bendesc_yn === "1", aids, allowance: hearingAllowance },
      otc: {
        offered: otcOffered,
        allowance:
          otcOffered && b13.pbp_b13b_maxplan_yn === "1"
            ? allowanceLabel(num(b13.pbp_b13b_maxplan_amt), b13.pbp_b13b_otc_maxplan_per)
            : null,
      },
      fitness: included(first(sections, "b14_preventive").pbp_b14c_bendesc_amo_mhc),
      meals: b13.pbp_b13c_bendesc_service === "1",
      transportation: first(sections, "b10_amb_trans").pbp_b10b_bendesc_yn === "1",
    },
    drugs: {
      covered: mrx.mrx_drug_ben_yn === "1" ? true : mrx.mrx_drug_ben_yn === "2" ? false : null,
      deductible: drugDeductible,
    },
  };
}
