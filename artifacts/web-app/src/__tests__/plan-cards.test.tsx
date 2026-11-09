// @vitest-environment jsdom
/**
 * Plan cards: the sorting / filtering / badge rules, the card itself, and the
 * Quoting page flow (county search -> cards -> filter -> compare).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import QuotingPage from "@/pages/QuotingPage";
import { PlanCard } from "@/components/quoting/PlanCard";
import { bestFlags, extraChips, filterPlans, sortPlans, type FilterKey } from "@/components/quoting/planCardModel";
import type { PlanCardData, PlanSummary } from "@/lib/portalDialer/api";

const baseCard = (over: Partial<PlanCardData> = {}): PlanCardData => ({
  premium: 0,
  partBGiveback: null,
  moopInNetwork: 5900,
  moopCombined: null,
  deductible: null,
  costs: {
    pcp: { kind: "copay", label: "$0" },
    specialist: { kind: "copay", label: "$40" },
    er: { kind: "copay", label: "$115" },
    urgentCare: { kind: "copay", label: "$40" },
    hospital: "$350 per day, days 1–5; $0 for days 6–90",
  },
  extras: {
    dental: { preventive: true, comprehensive: true, maximum: "$2,000 per year (preventive and comprehensive combined)" },
    vision: { exam: true, eyewear: true, allowance: "$150 per year" },
    hearing: { exam: true, aids: false, allowance: null },
    otc: { offered: true, allowance: "$75 per quarter" },
    fitness: true,
    meals: false,
    transportation: false,
  },
  drugs: { covered: true, deductible: "$0" },
  ...over,
});

const mkPlan = (bidId: string, name: string, org: string, card: PlanCardData | null, over: Partial<PlanSummary> = {}): PlanSummary => ({
  bidId,
  contractId: bidId.slice(0, 5),
  planId: "001",
  segmentId: "0",
  planName: name,
  orgName: org,
  orgMarketingName: org,
  planTypeLabel: "HMO",
  isSnp: false,
  snpType: null,
  orgWebsite: null,
  partial: false,
  card,
  ...over,
});

const A = mkPlan("H1000_001_0", "Alpha Gold", "Acme", baseCard({ premium: 0, moopInNetwork: 4000 }));
const B = mkPlan("H2000_001_0", "Beta Plus", "Beta", baseCard({ premium: 25, moopInNetwork: 6500, partBGiveback: 50 }));
const C = mkPlan("H3000_001_0", "Cobalt Saver", "Cobalt", baseCard({ premium: 10, moopInNetwork: null, moopCombined: 8000, drugs: { covered: false, deductible: null } }));
const D = mkPlan("H4000_001_0", "Delta Unknown", "Delta", null, { planTypeLabel: "PPO" });

describe("plan card model", () => {
  it("sorts by premium with unknown values last", () => {
    expect(sortPlans([B, D, A, C], "premium").map((p) => p.bidId)).toEqual([A.bidId, C.bidId, B.bidId, D.bidId]);
  });
  it("sorts by out-of-pocket max using the combined max when there is no in-network one", () => {
    expect(sortPlans([B, D, A, C], "moop").map((p) => p.bidId)).toEqual([A.bidId, B.bidId, C.bidId, D.bidId]);
  });
  it("sorts by Part B giveback, highest first", () => {
    expect(sortPlans([A, B, C], "giveback")[0]!.bidId).toBe(B.bidId);
  });
  it("filters keep only plans whose data proves the claim", () => {
    const on = (...k: FilterKey[]) => filterPlans([A, B, C, D], new Set(k), "").map((p) => p.bidId);
    expect(on("zeroPremium")).toEqual([A.bidId]);
    expect(on("drugs")).toEqual([A.bidId, B.bidId]);
    expect(on("giveback")).toEqual([B.bidId]);
    expect(on("dental", "fitness")).toEqual([A.bidId, B.bidId, C.bidId]); // plan without data is never shown as a match
    expect(filterPlans([A, D], new Set(), "PPO").map((p) => p.bidId)).toEqual([D.bidId]);
  });
  it("marks a best plan only when it is clearly best among 3+", () => {
    const f = bestFlags([A, B, C]);
    expect(f.get(A.bidId)).toEqual({ lowestPremium: true, lowestMoop: true });
    expect(f.get(B.bidId)).toEqual({ lowestPremium: false, lowestMoop: false });
    const tie = bestFlags([A, mkPlan("H5000_001_0", "Tie", "T", baseCard({ premium: 0 })), B]);
    expect(tie.get(A.bidId)!.lowestPremium).toBe(false);
    expect(bestFlags([A, B]).get(A.bidId)).toEqual({ lowestPremium: false, lowestMoop: false });
  });
  it("lists only included extras", () => {
    expect(extraChips(baseCard()).map((c) => c.key)).toEqual(["dental", "vision", "hearing", "otc", "fitness"]);
  });
});

function renderCard(plan: PlanSummary, props: Partial<React.ComponentProps<typeof PlanCard>> = {}) {
  const onToggleCompare = vi.fn();
  const onToggleOpen = vi.fn();
  render(
    <PlanCard
      plan={plan}
      compareSelected={false}
      compareDisabled={false}
      onToggleCompare={onToggleCompare}
      open={false}
      onToggleOpen={onToggleOpen}
      {...props}
    />,
  );
  return { onToggleCompare, onToggleOpen };
}

describe("plan ordering with missing data", () => {
  it("giveback sort puts plans without benefit data after a real $0 giveback", () => {
    const zero = mkPlan("H7000_001_0", "Zzz Zero", "Z", baseCard({ partBGiveback: null }));
    const none = mkPlan("H7001_001_0", "Aaa None", "A", null);
    const fifty = mkPlan("H7002_001_0", "Yyy Fifty", "Y", baseCard({ partBGiveback: 50 }));
    expect(sortPlans([zero, none, fifty], "giveback").map((p) => p.planName)).toEqual(["Yyy Fifty", "Zzz Zero", "Aaa None"]);
  });
});

describe("PlanCard", () => {
  it("shows premium, giveback, key costs and extras in plain words", () => {
    renderCard(B);
    const card = screen.getByRole("article", { name: "Beta Plus" });
    expect(within(card).getByText("$25")).toBeInTheDocument();
    expect(within(card).getByText("Health plan premium")).toBeInTheDocument();
    expect(within(card).getByText(/Pays back \$50\/mo of your Part B premium/)).toBeInTheDocument();
    expect(within(card).getByText("Out-of-pocket max")).toBeInTheDocument();
    expect(within(card).getByText("$6,500")).toBeInTheDocument();
    const specialistRow = within(card).getByText("Specialist visit").parentElement!;
    expect(within(specialistRow).getByText("$40")).toBeInTheDocument();
    expect(within(card).getByText("$115")).toBeInTheDocument();
    expect(within(card).getByText("$75 per quarter")).toBeInTheDocument();
    expect(within(card).getByText(/Prescription drugs:/)).toBeInTheDocument();
  });

  it("says the drug premium is not included when the plan has drug coverage", () => {
    renderCard(A);
    expect(screen.getByText(/Part D\) premium is not included/)).toBeInTheDocument();
  });

  it("does not claim a drug note for a plan without drug coverage", () => {
    renderCard(C);
    expect(screen.queryByText(/Part D\) premium is not included/)).not.toBeInTheDocument();
    expect(screen.getByText("Not included")).toBeInTheDocument();
  });

  it("shows 'See details' instead of a number it does not have", () => {
    renderCard(mkPlan("H6000_001_0", "Sparse", "S", baseCard({ premium: null, moopInNetwork: null, costs: { pcp: null, specialist: null, er: null, urgentCare: null, hospital: null } })));
    expect(screen.getByText("Premium not listed")).toBeInTheDocument();
    expect(screen.getAllByText("See details").length).toBeGreaterThanOrEqual(5);
  });

  it("falls back to a note when no benefit data is loaded", () => {
    renderCard(D);
    expect(screen.getByText(/Benefit details for this plan are not loaded/)).toBeInTheDocument();
  });

  it("toggles compare and details from the keyboard-reachable controls", async () => {
    const { onToggleCompare, onToggleOpen } = renderCard(A);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Compare Alpha Gold" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onToggleCompare).toHaveBeenCalledWith(A.bidId);
    await user.tab();
    expect(screen.getByRole("button", { name: /Full details/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onToggleOpen).toHaveBeenCalledWith(A.bidId);
  });

  it("disables compare checkboxes of unselected cards once the limit is reached", () => {
    renderCard(A, { compareDisabled: true });
    expect(screen.getByRole("checkbox", { name: "Compare Alpha Gold" })).toBeDisabled();
  });
});

// ---- page flow --------------------------------------------------------------

const ADMIN = { id: "u-admin", orgId: "o-1", email: "a@example.com", fullName: "Admin", role: "agency_admin", isActive: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(getGetMeQueryKey(), ADMIN);
  const { hook, searchHook } = memoryLocation({ path: "/quoting", static: true } as never) as unknown as { hook: never; searchHook: never };
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <TooltipProvider>
          <QuotingPage />
        </TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/carriers")) return json([]);
    if (url.includes("plan-areas/states")) return json({ data: [{ stateCode: "TX" }], planYear: 2027 });
    if (url.includes("plan-areas/counties")) return json({ data: [{ countyCode: "45910", countyName: "Tarrant" }], planYear: 2027 });
    if (url.includes("/api/quoting/plans?")) {
      const q = (new URL(url, "http://x").searchParams.get("q") ?? "").toLowerCase();
      if (q === "boom") return json({ error: "boom" }, 500);
      const data = [A, B, C, D].filter((p) => !q || (p.planName ?? "").toLowerCase().includes(q));
      return json({ data, total: data.length, truncated: false, planYear: 2027 });
    }
    return json({ error: "not found" }, 404);
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function openCounty() {
  renderPage();
  await screen.findByRole("option", { name: "TX" });
  await userEvent.selectOptions(screen.getByLabelText("State"), "TX");
  await screen.findByRole("option", { name: "Tarrant" });
  await userEvent.selectOptions(screen.getByLabelText("County"), "45910");
  await screen.findAllByTestId("plan-card");
}

describe("Quoting page plan cards", () => {
  it("shows one card per plan with honest footnotes", async () => {
    await openCounty();
    expect(screen.getAllByTestId("plan-card")).toHaveLength(4);
    expect(screen.getByText(/health plan premium only/i)).toBeInTheDocument();
    expect(screen.getByText(/Confirm the details with the carrier/)).toBeInTheDocument();
    expect(screen.queryByText(/not decoded yet/i)).not.toBeInTheDocument();
  });

  it("filters and sorts", async () => {
    await openCounty();
    await userEvent.click(screen.getByRole("button", { name: "Part B giveback" }));
    expect(screen.getAllByTestId("plan-card")).toHaveLength(1);
    expect(screen.getByText("1 of 4 plans match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Part B giveback" }));
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "premium");
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names.slice(0, 3)).toEqual(["Alpha Gold", "Cobalt Saver", "Beta Plus"]);
  });

  it("compares two plans side by side", async () => {
    await openCounty();
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Alpha Gold" }));
    expect(screen.getByRole("button", { name: /Compare \(pick 2\+\)/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Beta Plus" }));
    await userEvent.click(screen.getByRole("button", { name: /^Compare$/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Compare plans")).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: /Alpha Gold/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: /Beta Plus/ })).toBeInTheDocument();
    const premiumRow = within(dialog).getByRole("row", { name: /Monthly premium/ });
    expect(within(premiumRow).getByText("$0")).toBeInTheDocument();
    expect(within(premiumRow).getByText("$25")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByText(/\(best\)/).length).toBeGreaterThan(0));
  });

  it("forgets picked plans that a search removes, so Compare never does nothing", async () => {
    await openCounty();
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Alpha Gold" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Beta Plus" }));
    expect(screen.getByText("2 plans selected")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Plan or carrier name"), "cobalt");
    await waitFor(() => expect(screen.getAllByTestId("plan-card")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/plans? selected/)).not.toBeInTheDocument());
    await userEvent.clear(screen.getByLabelText("Plan or carrier name"));
    await waitFor(() => expect(screen.getAllByTestId("plan-card")).toHaveLength(4));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Compare Alpha Gold" })).not.toBeChecked();
  });

  it("does not bring old picks or the dialog back after a search with no results is cleared", async () => {
    await openCounty();
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Alpha Gold" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Beta Plus" }));
    await userEvent.type(screen.getByLabelText("Plan or carrier name"), "zzz");
    await screen.findByText("No plans found");
    await userEvent.clear(screen.getByLabelText("Plan or carrier name"));
    await waitFor(() => expect(screen.getAllByTestId("plan-card")).toHaveLength(4));
    expect(screen.queryByText(/plans? selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not bring old picks back after a failed search is cleared", async () => {
    await openCounty();
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Alpha Gold" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Compare Beta Plus" }));
    await userEvent.type(screen.getByLabelText("Plan or carrier name"), "boom");
    await waitFor(() => expect(screen.queryAllByTestId("plan-card")).toHaveLength(0));
    await userEvent.clear(screen.getByLabelText("Plan or carrier name"));
    await waitFor(() => expect(screen.getAllByTestId("plan-card")).toHaveLength(4));
    expect(screen.queryByText(/plans? selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the plan type menu while a type is chosen so the filter can be cleared", async () => {
    await openCounty();
    const typeMenu = () => document.getElementById("plan-type") as HTMLSelectElement;
    await userEvent.selectOptions(typeMenu(), "PPO");
    expect(screen.getAllByTestId("plan-card")).toHaveLength(1);
    await userEvent.type(screen.getByLabelText("Plan or carrier name"), "cobalt");
    await screen.findByText("No plans match those filters");
    await userEvent.selectOptions(typeMenu(), "");
    await waitFor(() => expect(screen.getAllByTestId("plan-card")).toHaveLength(1));
  });

  it("labels the premium filter and sort as the health plan premium", async () => {
    await openCounty();
    expect(screen.getByRole("button", { name: "$0 health plan premium" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Lowest health plan premium" })).toBeInTheDocument();
  });
});
