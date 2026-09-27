// @vitest-environment jsdom
/**
 * Render tests for the stage-2 core pages: Policies, Workflow Automation,
 * Reconciliation, Agent Back Office, Data Tools and Knowledge Base.
 * The API client is mocked; each page must render the real response it is
 * given, honest empty states, and "Coming soon" only where there's no engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);

const state = vi.hoisted(() => ({
  role: "agency_admin",
  responses: {} as Record<string, unknown>,
}));

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false });
  return {
    customFetch: vi.fn(async (url: string) => {
      const path = String(url).split("?")[0]!;
      if (path in state.responses) return state.responses[path];
      throw Object.assign(new Error("not mocked"), { status: 404, data: { error: "not mocked" } });
    }),
    useGetMe: () => ({ data: { id: "u1", role: state.role }, isLoading: false }),
    useGetAgents: () => ({
      data: { agents: [{ id: "a1", firstName: "Dana", lastName: "Reyes" }], total: 1 },
      isLoading: false,
    }),
    useGetCarriers: () => ({ data: [{ id: "c1", name: "Humana" }] }),
    useGetContacts: () => ({ data: { data: [], total: 48 } }),
    useGetAutomationRules: () => ({
      data: {
        rules: [
          {
            id: "r1", orgId: "o", name: "Welcome new leads", triggerType: "lead_created", triggerConfig: null,
            conditions: [], actions: [{ type: "create_task", config: {} }, { type: "send_sms", config: {} }],
            isActive: true, runCount: 3, lastRunAt: null, createdAt: "", updatedAt: "",
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    }),
    useGetAutomationRuleLogs: () => ({ data: [], isLoading: false }),
    useToggleAutomationRule: noopMutation,
    useDeleteAutomationRule: noopMutation,
    useRunAutomationRule: noopMutation,
    useCreateAutomationRule: noopMutation,
    useUpdateAutomationRule: noopMutation,
    getGetAutomationRulesQueryKey: () => ["/api/automations/rules"],
    getGetAutomationRuleLogsQueryKey: (id: string) => ["/api/automations/rules", id, "logs"],
  };
});

// The reconciliation page reuses the upload dialog from the commissions page.
vi.mock("@/pages/commissions", () => ({ UploadStatementDialog: () => null }));

function renderPage(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  state.role = "agency_admin";
  state.responses = {};
});

describe("Policies page", () => {
  it("lists real enrollments with client links and exact counts", async () => {
    state.responses = {
      "/api/enrollments": [
        {
          id: "e1", contactId: "c9", carrierId: "c1", carrierName: "Humana", agentId: "a1", planId: null,
          planName: "Gold Plus", planType: "MAPD", planYear: 2026, policyNumber: "POL-1", effectiveDate: "2026-01-01",
          effectuated: true, status: "active", contactFirstName: "Mary", contactLastName: "Wilson",
          agentFirstName: "Dana", agentLastName: "Reyes",
        },
      ],
      "/api/enrollments/summary": { total: 1, active: 1, pending: 0, ended: 0, effectuated: 1, notEffectuated: 0, startingSoon: 0 },
    };
    const { default: PoliciesPage } = await import("@/pages/policies");
    renderPage(<PoliciesPage />);
    const link = await screen.findByRole("link", { name: "Mary Wilson" });
    expect(link).toHaveAttribute("href", "/crm/contacts/c9");
    expect(screen.getByText("Showing 1–1 of 1 policy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export csv/i })).toBeInTheDocument();
  });

  it("shows an honest empty state with no policies", async () => {
    state.responses = {
      "/api/enrollments": [],
      "/api/enrollments/summary": { total: 0, active: 0, pending: 0, ended: 0, effectuated: 0, notEffectuated: 0, startingSoon: 0 },
    };
    const { default: PoliciesPage } = await import("@/pages/policies");
    renderPage(<PoliciesPage />);
    expect(await screen.findByText("No policies yet")).toBeInTheDocument();
  });
});

describe("Workflow Automation page", () => {
  it("reads each rule as a plain-language sentence", async () => {
    state.responses = { "/api/automations/recent-activity": { recent: [], last24h: { success: 0, partial: 0, failed: 0 }, total: 0 } };
    const { default: WorkflowsPage } = await import("@/pages/workflows");
    renderPage(<WorkflowsPage />);
    expect(await screen.findByText("Welcome new leads")).toBeInTheDocument();
    expect(screen.getByText("When a new lead comes in → create a task and send a text")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /pause welcome new leads/i })).toBeInTheDocument();
  });

  it("hides editing controls from non-owners", async () => {
    state.role = "compliance_manager";
    state.responses = { "/api/automations/recent-activity": { recent: [], last24h: { success: 0, partial: 0, failed: 0 }, total: 0 } };
    const { default: WorkflowsPage } = await import("@/pages/workflows");
    renderPage(<WorkflowsPage />);
    await screen.findByText("Welcome new leads");
    expect(screen.queryByRole("button", { name: /new rule/i })).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});

describe("Reconciliation page", () => {
  it("shows real variance alerts and labels unbuilt features as coming soon", async () => {
    state.responses = {
      "/api/commissions/reconciliation/overview": {
        statements: [{
          id: "s1", carrierName: "Humana", statementDate: "2026-03-01", periodStart: "2026-02-01", periodEnd: "2026-02-28",
          status: "parsed", totalAmount: 310, lineItemCount: 2, unmatchedCount: 1, lineItemTotal: 300, variance: 10,
        }],
        totals: {
          statements: 1, statementsPending: 0, statementsParsed: 1, statementsReconciled: 0, lineItems: 2, matched: 1,
          manual: 0, unmatched: 1, unmatchedAmount: 100, statementsWithVariance: 1, varianceAmount: 10,
          openMissedPayments: 0, missedExpectedAmount: 0,
        },
        unmatchedItems: [],
        missedPayments: [],
      },
      "/api/clawbacks/summary": { clawbackTotal: 0, chargebackCount: 0, windowDays: 365 },
    };
    const { default: ReconciliationPage } = await import("@/pages/reconciliation");
    renderPage(<ReconciliationPage />);
    expect(await screen.findByText("Statement total doesn't match its lines")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /disputes/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /1099/i })).toBeInTheDocument();
  });
});

describe("Agent Back Office page", () => {
  it("shows the agent's own back office for the agent role", async () => {
    state.role = "agent";
    state.responses = {
      "/api/agents/me/backoffice": {
        agent: { id: "a1", firstName: "Dana", lastName: "Reyes", email: "dana@example.com", phone: null, status: "active", hireDate: null, npn: null, avatarUrl: null },
        readiness: { readyToSell: false, blockers: ["AHIP not current"], ahipCurrent: false, licensedStates: ["TX"], certifiedCarriers: [], certificationYear: 2026 },
        complianceScore: { totalScore: 40, activeLicenses: 1, totalLicenses: 1, activeCertifications: 0, totalCertifications: 0, ahipCompleted: false, onboardingCompletedItems: 0, onboardingTotalItems: 0 },
        ahip: [], licenses: [], certifications: [], portals: [], documents: [], checklists: [],
        tasks: [{ id: "t1", title: "Finish AHIP", dueDate: null, priority: "high", status: "open" }],
      },
    };
    const { default: AgentBackofficePage } = await import("@/pages/agent-backoffice");
    renderPage(<AgentBackofficePage />);
    expect(await screen.findByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.getByText("My Back Office")).toBeInTheDocument();
    expect(screen.getByText("Finish AHIP")).toBeInTheDocument();
    expect(screen.getByText(/AHIP not current/)).toBeInTheDocument();
    // Agents don't get the agent picker.
    expect(screen.queryByRole("combobox", { name: /choose an agent/i })).not.toBeInTheDocument();
  });
});

describe("Data Tools page", () => {
  it("offers real exports with counts and downloadable templates", async () => {
    state.responses = {
      "/api/enrollments/summary": { total: 38 },
      "/api/imports/history": [],
    };
    const { default: DataToolsPage } = await import("@/pages/data-tools");
    renderPage(<DataToolsPage />);
    expect(await screen.findByRole("button", { name: "Export 48 clients" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download csv template/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the import wizard/i })).toHaveAttribute("href", "/data-migration");
  });
});

describe("Knowledge Base page", () => {
  it("lists articles and lets owners add more", async () => {
    state.responses = {
      "/api/kb/articles": {
        articles: [{
          id: "k1", category: "Enrollment", title: "When can clients switch?", content: "AEP runs Oct 15 – Dec 7.",
          keywords: ["aep"], isActive: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        }],
        stats: { total: 1, active: 1, categories: 1, keywords: 1 },
      },
    };
    const { default: KnowledgeBasePage } = await import("@/pages/knowledge-base");
    renderPage(<KnowledgeBasePage />);
    expect(await screen.findByText("When can clients switch?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add article/i })).toBeInTheDocument();
  });

  it("is read-only for agents", async () => {
    state.role = "agent";
    state.responses = { "/api/kb/articles": { articles: [], stats: { total: 0, active: 0, categories: 0, keywords: 0 } } };
    const { default: KnowledgeBasePage } = await import("@/pages/knowledge-base");
    renderPage(<KnowledgeBasePage />);
    expect(await screen.findByText("No articles yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add article/i })).not.toBeInTheDocument();
  });
});

describe("rule sentences", () => {
  it("fills in day thresholds and joins steps naturally", async () => {
    const { ruleSentence } = await import("@/components/automations/workflowCopy");
    expect(
      ruleSentence("license_expires", { daysThreshold: 45 }, [
        { type: "send_notification", config: {} },
        { type: "create_task", config: {} },
        { type: "send_email", config: {} },
      ]),
    ).toBe("When an agent's license expires within 45 days → send an in-app alert, create a task and send an email");
  });
});
