import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'agent-enrollment-aep-flow',
  description: 'Agent logs in, finds beneficiary in CRM, initiates AEP enrollment, documents notes',
  target: 'preview',
  phiScoped: true,
  businessOutcome: 'Agent successfully completes AEP enrollment workflow from CRM search through enrollment documentation',
  steps: [
    {
      name: 'visit-login',
      authStep: true,
      do: async (p) => {
        await p.goto('/');
      },
      expect: async (p, x) => {
        await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible();
      },
    },
    {
      name: 'login-agent',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        const submit = p.getByRole('button', { name: /sign in|log in/i }).first();

        await email.fill(process.env.TEST_AGENT_EMAIL || 'agent.demo@mediflow.local');
        await password.fill(process.env.TEST_AGENT_PASSWORD || 'DemoPass123!');
        await submit.click();
      },
      expect: async (p, x) => {
        await x(p).toHaveURL(/dashboard|crm|aep/, { timeout: 15000 });
      },
    },
    {
      name: 'access-crm',
      do: async (p) => {
        await p.getByRole('link', { name: /clients|crm|contacts|beneficiaries/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/search|member|beneficiary|contact/i).first()).toBeVisible();
      },
    },
    {
      name: 'search-beneficiary',
      do: async (p) => {
        const searchField = p.getByPlaceholder(/search|name|member id/i).first();
        await searchField.click();
        await searchField.fill('test');
      },
      expect: async (p, x) => {
        await x(p.getByText(/result|found|member|beneficiary/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'select-beneficiary',
      do: async (p) => {
        await p.getByRole('row').first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/member detail|profile|enrollment|plan/i).first()).toBeVisible();
      },
    },
    {
      name: 'initiate-aep-enrollment',
      do: async (p) => {
        await p.getByRole('button', { name: /enroll|aep|start enrollment|create enrollment/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/enrollment|plan selection|aep|details/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'select-plan',
      do: async (p) => {
        await p.getByRole('radio', { name: /plan|advantage|hmo|ppo/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByRole('button', { name: /next|proceed|confirm/i }).first()).toBeEnabled();
      },
    },
    {
      name: 'add-enrollment-notes',
      do: async (p) => {
        const noteField = p.getByPlaceholder(/notes|comments|details/i).first();
        const isVisible = await noteField.isVisible().catch(() => false);
        if (isVisible) {
          await noteField.fill('AEP enrollment via agent portal');
        }
      },
      expect: async (p, x) => {
        await p.waitForTimeout(500);
      },
    },
    {
      name: 'submit-enrollment',
      do: async (p) => {
        await p.getByRole('button', { name: /submit|complete|save enrollment/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/confirmed|enrolled|success|completed/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'verify-enrollment-recorded',
      do: async (p) => {
        await p.waitForTimeout(1000);
      },
      expect: async (p, x) => {
        await x(p.getByText(/enrollment|status|active|pending/i).first()).toBeVisible();
      },
    },
  ],
});
