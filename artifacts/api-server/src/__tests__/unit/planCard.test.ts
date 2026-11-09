import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/planCards.json";
import { buildPlanCard, CARD_COLUMNS, formatMoney, snpTypeLabel, type Sections } from "../../lib/planCard";

/**
 * Real CMS PBP 2027 plans, trimmed to the columns the card reads. Expected
 * values were checked by hand against the raw CMS fields printed next to them.
 */
const byCase = Object.fromEntries(
  (fixtures as { case: string; sections: Sections }[]).map((f) => [f.case, buildPlanCard(f.sections)]),
);

describe("buildPlanCard on real 2027 plans", () => {
  it("HMO with a Part B giveback", () => {
    const c = byCase.hmo_zero_giveback!;
    expect(c.premium).toBe(0);
    expect(c.partBGiveback).toBe(113);
    expect(c.moopInNetwork).toBe(9850);
    expect(c.deductible).toBeNull(); // CMS left the question blank: not claimed
    expect(c.costs.pcp).toEqual({ kind: "copay", label: "$0" });
    expect(c.costs.specialist?.label).toBe("$40");
    expect(c.costs.er?.label).toBe("$115");
    expect(c.costs.urgentCare?.label).toBe("$40");
    expect(c.costs.hospital).toBe("$385 per day, days 1–7; $0 for days 8–90");
    expect(c.extras.vision).toEqual({ exam: true, eyewear: true, allowance: "$100 per year" });
    expect(c.extras.dental.maximum).toBeNull();
    expect(c.extras.meals).toBe(true);
    expect(c.extras.otc.offered).toBe(false);
    expect(c.drugs).toEqual({ covered: true, deductible: "Standard Part D deductible" });
  });

  it("PPO with a deductible, combined limit and coinsurance", () => {
    const c = byCase.ppo_combined_coins!;
    expect(c.deductible).toBe(800);
    expect(c.moopInNetwork).toBe(9850);
    expect(c.moopCombined).toBe(14800);
    // CMS says "no copay, no coinsurance", but the plan has an $800 deductible
    // that may apply: not claimed as $0.
    expect(c.costs.pcp).toBeNull();
    expect(c.costs.specialist).toEqual({ kind: "coinsurance", label: "30%" });
    // "0%–20%" may mean 0% only after the $800 deductible: not claimed.
    expect(c.costs.urgentCare).toBeNull();
    expect(c.costs.hospital).toBe("$2,241 per stay");
    expect(c.extras.dental.maximum).toBe("$3,000 per year (preventive + comprehensive)");
    expect(c.extras.otc).toEqual({ offered: true, allowance: "$50 per quarter" });
    expect(c.extras.fitness).toBe(true);
    expect(c.drugs.deductible).toBe("$461");
  });

  it("D-SNP with no cost sharing", () => {
    const c = byCase.dsnp_zero_share!;
    expect(c.costs.pcp?.label).toBe("$0");
    expect(c.costs.specialist?.kind).toBe("none");
    expect(c.costs.er?.label).toBe("$0");
    expect(c.costs.hospital).toBe("$0 per stay");
    expect(c.extras.transportation).toBe(true);
    expect(c.extras.otc.allowance).toBe("$210 per quarter");
  });

  it("plan with a monthly premium and a deductible", () => {
    const c = byCase.premium_deductible!;
    expect(c.premium).toBe(2);
    expect(c.deductible).toBe(400);
    expect(c.moopInNetwork).toBe(4450);
    expect(c.moopCombined).toBe(4450);
    expect(c.drugs.deductible).toBe("$450");
  });

  it("plan without drug coverage", () => {
    const c = byCase.no_drugs!;
    expect(c.drugs).toEqual({ covered: false, deductible: null });
    expect(c.deductible).toBe(0); // CMS says "no" explicitly
    expect(c.partBGiveback).toBe(140.5);
  });

  it("coinsurance everywhere, hospital left unreadable instead of guessed", () => {
    const c = byCase.hospital_coins!;
    expect(c.costs.pcp).toEqual({ kind: "coinsurance", label: "20%" });
    expect(c.costs.hospital).toBeNull();
  });

  it("copay ranges", () => {
    const c = byCase.urgent_range!;
    expect(c.costs.specialist?.label).toBe("$0–$35");
    expect(c.costs.urgentCare?.label).toBe("$0–$50");
    expect(c.extras.vision.allowance).toBe("$250 every 2 years");
    expect(c.extras.hearing.allowance).toBe("$700 per year");
  });

  it("zero drug deductible and a combined dental limit", () => {
    const c = byCase.dental_shared!;
    expect(c.drugs.deductible).toBe("$0");
    expect(c.moopInNetwork).toBe(1100);
    expect(c.extras.dental.maximum).toBe("$3,000 per year (preventive + comprehensive)");
  });

  it("per-ear hearing allowance and a monthly OTC allowance", () => {
    const c = byCase.drug_std_ded!;
    expect(c.extras.hearing.allowance).toBe("$1,500 per year per ear");
    expect(c.extras.otc.allowance).toBe("$100 per month");
  });
});

describe("buildPlanCard never guesses", () => {
  it("returns nulls and false flags when nothing is known", () => {
    const c = buildPlanCard({});
    expect(c.premium).toBeNull();
    expect(c.moopInNetwork).toBeNull();
    expect(c.costs).toEqual({ pcp: null, specialist: null, er: null, urgentCare: null, hospital: null });
    expect(c.drugs).toEqual({ covered: null, deductible: null });
    expect(c.extras.dental).toEqual({ preventive: false, comprehensive: false, maximum: null });
  });

  it("a 'yes' copay with no amount stays unknown, not $0", () => {
    const c = buildPlanCard({ b7_health_prof: [{ pbp_b7a_copay_yn: "1", pbp_b7a_coins_yn: "2" }] });
    expect(c.costs.pcp).toBeNull();
  });

  it("ignores an allowance with an unknown period", () => {
    const c = buildPlanCard({
      b13_other_services: [
        { pbp_b13b_bendesc_otc: "1", pbp_b13b_maxplan_yn: "1", pbp_b13b_maxplan_amt: "75.00", pbp_b13b_otc_maxplan_per: "6" },
      ],
    });
    expect(c.extras.otc).toEqual({ offered: true, allowance: null });
  });

  it("optional-only benefits (type 3) are not counted as included", () => {
    const c = buildPlanCard({
      b16_dental: [{ pbp_b16b_bendesc_oe_amo: "3", pbp_b16c_bendesc_rs_amo: "3" }],
      b14_preventive: [{ pbp_b14c_bendesc_amo_mhc: "3" }],
    });
    expect(c.extras.dental.preventive).toBe(false);
    expect(c.extras.dental.comprehensive).toBe(false);
    expect(c.extras.fitness).toBe(false);
  });

  it("a tiered hospital structure is left out of the card", () => {
    const c = buildPlanCard({
      b1a_inpat_hosp: [{ pbp_b1a_cost_vary_tiers_yn: "1", pbp_b1a_copay_yn: "1", pbp_b1a_copay_mcs_amt_t1: "300.00" }],
    });
    expect(c.costs.hospital).toBeNull();
  });
});

describe("buildPlanCard never shows a partial or understated cost", () => {
  const b7 = (o: Record<string, string>) => buildPlanCard({ b7_health_prof: [o] }).costs.pcp;

  it("copay and coinsurance both apply but only one is readable: unknown", () => {
    expect(b7({ pbp_b7a_copay_yn: "1", pbp_b7a_copay_amt_mc_min: "40", pbp_b7a_copay_amt_mc_max: "40", pbp_b7a_coins_yn: "1" })).toBeNull();
    expect(b7({ pbp_b7a_copay_yn: "1", pbp_b7a_coins_yn: "1", pbp_b7a_coins_pct_mc_min: "20", pbp_b7a_coins_pct_mc_max: "20" })).toBeNull();
  });

  it("both readable: shown together", () => {
    expect(
      b7({
        pbp_b7a_copay_yn: "1", pbp_b7a_copay_amt_mc_min: "40", pbp_b7a_copay_amt_mc_max: "40",
        pbp_b7a_coins_yn: "1", pbp_b7a_coins_pct_mc_min: "20", pbp_b7a_coins_pct_mc_max: "20",
      }),
    ).toEqual({ kind: "mixed", label: "$40 or 20%" });
  });

  it("a min-and-max range with a missing bound is unknown, not a fixed price", () => {
    expect(b7({ pbp_b7a_copay_yn: "3", pbp_b7a_copay_amt_mc_min: "0", pbp_b7a_coins_yn: "2" })).toBeNull();
    expect(b7({ pbp_b7a_copay_yn: "3", pbp_b7a_copay_amt_mc_max: "35", pbp_b7a_coins_yn: "2" })).toBeNull();
    expect(b7({ pbp_b7a_copay_yn: "3", pbp_b7a_copay_amt_mc_min: "0", pbp_b7a_copay_amt_mc_max: "35", pbp_b7a_coins_yn: "2" })?.label).toBe("$0–$35");
  });

  it("a plan deductible stops a bare $0 from being claimed", () => {
    const row = { pbp_b7a_copay_yn: "2", pbp_b7a_coins_yn: "2" };
    expect(buildPlanCard({ b7_health_prof: [row], section_d: [{ pbp_d_ann_deduct_yn: "1", pbp_d_ann_deduct_amt: "500" }] }).costs.pcp).toBeNull();
    expect(buildPlanCard({ b7_health_prof: [row], section_d: [{ pbp_d_ann_deduct_yn: "2" }] }).costs.pcp).toEqual({ kind: "none", label: "$0" });
  });

  it("any $0-leading cost is hidden when a deductible may apply (set, or flagged with no amount)", () => {
    const zeroCopay = { pbp_b7a_copay_yn: "1", pbp_b7a_coins_yn: "2", pbp_b7a_copay_amt_mc_min: "0", pbp_b7a_copay_amt_mc_max: "0" };
    const range = { pbp_b7a_copay_yn: "3", pbp_b7a_coins_yn: "2", pbp_b7a_copay_amt_mc_min: "0", pbp_b7a_copay_amt_mc_max: "40" };
    const deductibles: Record<string, string>[] = [{ pbp_d_ann_deduct_yn: "1", pbp_d_ann_deduct_amt: "500" }, { pbp_d_ann_deduct_yn: "1" }];
    for (const d of deductibles) {
      expect(buildPlanCard({ b7_health_prof: [zeroCopay], section_d: [d] }).costs.pcp).toBeNull();
      expect(buildPlanCard({ b7_health_prof: [range], section_d: [d] }).costs.pcp).toBeNull();
      expect(buildPlanCard({ b1a_inpat_hosp: [{ pbp_b1a_copay_yn: "2", pbp_b1a_coins_yn: "2" }], section_d: [d] }).costs.hospital).toBeNull();
    }
    const zeroPct = { pbp_b7a_copay_yn: "2", pbp_b7a_coins_yn: "3", pbp_b7a_coins_pct_mc_min: "0", pbp_b7a_coins_pct_mc_max: "20" };
    expect(buildPlanCard({ b7_health_prof: [zeroPct], section_d: [deductibles[0]!] }).costs.pcp).toBeNull();
    expect(buildPlanCard({ b1a_inpat_hosp: [{ pbp_b1a_coins_yn: "1", pbp_b1a_copay_yn: "2", pbp_b1a_coins_mcs_pct_t1: "0" }], section_d: [deductibles[0]!] }).costs.hospital).toBeNull();
    const none = { pbp_d_ann_deduct_yn: "2" };
    expect(buildPlanCard({ b7_health_prof: [zeroCopay], section_d: [none] }).costs.pcp?.label).toBe("$0");
  });

  const hosp = (o: Record<string, string>) => buildPlanCard({ b1a_inpat_hosp: [o] }).costs.hospital;

  it("hospital: a half-filled interval is unknown, not a placeholder or partial price", () => {
    expect(hosp({ pbp_b1a_copay_yn: "1", pbp_b1a_copay_mcs_amt_int1_t1: "0", pbp_b1a_copay_mcs_bgnd_int1_t1: "8", pbp_b1a_copay_mcs_endd_int1_t1: "90", pbp_b1a_copay_mcs_amt_int2_t1: "385", pbp_b1a_copay_mcs_amt_t1: "0" })).toBeNull();
    expect(hosp({ pbp_b1a_copay_yn: "1", pbp_b1a_copay_mcs_amt_int1_t1: "385", pbp_b1a_copay_mcs_bgnd_int1_t1: "1", pbp_b1a_copay_mcs_endd_int1_t1: "7", pbp_b1a_copay_mcs_amt_int2_t1: "0", pbp_b1a_copay_mcs_bgnd_int2_t1: "8", pbp_b1a_copay_mcs_endd_int2_t1: "90" })).toBe("$385 per day, days 1–7; $0 for days 8–90");
  });

  it("hospital: copay and coinsurance together is not collapsed to one of them", () => {
    expect(hosp({ pbp_b1a_copay_yn: "1", pbp_b1a_coins_yn: "1", pbp_b1a_coins_mcs_pct_t1: "20", pbp_b1a_copay_mcs_amt_int1_t1: "300", pbp_b1a_copay_mcs_bgnd_int1_t1: "1", pbp_b1a_copay_mcs_endd_int1_t1: "5" })).toBeNull();
  });
});

describe("CARD_COLUMNS", () => {
  it("lists only lower-case column names (the API builds SQL from them)", () => {
    for (const cols of Object.values(CARD_COLUMNS)) {
      for (const c of cols) expect(c).toMatch(/^[a-z0-9_]+$/);
    }
  });
  it("covers every column the fixtures use", () => {
    for (const f of fixtures as { sections: Sections }[]) {
      for (const [section, rows] of Object.entries(f.sections)) {
        for (const key of Object.keys(rows[0] ?? {})) expect(CARD_COLUMNS[section]).toContain(key);
      }
    }
  });
});

describe("formatMoney", () => {
  it("drops cents on whole dollars", () => {
    expect(formatMoney(1500)).toBe("$1,500");
    expect(formatMoney(140.5)).toBe("$140.50");
  });
});

describe("snpTypeLabel", () => {
  it("turns CMS codes into words and leaves anything else alone", () => {
    expect(snpTypeLabel("3")).toBe("Dual-Eligible");
    expect(snpTypeLabel("4")).toBe("Chronic or Disabling Condition");
    expect(snpTypeLabel("1")).toBe("Institutional");
    expect(snpTypeLabel("9")).toBe("9");
    expect(snpTypeLabel(null)).toBeNull();
    expect(snpTypeLabel("")).toBeNull();
  });
});
