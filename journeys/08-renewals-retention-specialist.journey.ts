import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'renewals-retention-workflow',
  description: 'Renewals specialist logs in, views renewal candidates, initiates renewal outreach, documents outcomes',
  target: 'preview',
  phiScoped: true,
  businessOutcome: 'Renewals specialist can identify renewal candidates and manage renewal outreach campaigns',
  steps: [
    {
      name: 'visit-login',
      authStep: true,
      do: async (p) => { await p.goto('/'); },
      expect: async (p, x) => { await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible(); },
    },
    {
      name: 'login-renewals-specialist',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        await email.fill(process.env.TEST_RENEWALS_EMAIL || 'renewals.demo@mediflow.local');
        await password.fill(process.env.TEST_RENEWALS_PASSWORD || 'DemoPass123!');
        await p.getByRole('button', { name: /sign in|log in/i }).first().click();
      },
      expect: async (p, x) => { await x(p).toHaveURL(/renewal|readiness|churn/, { timeout: 15000 }); },
    },
    {
      name: 'access-renewals-dashboard',
      do: async (p) => { await p.getByRole('link', { name: /renewal|readiness|churn|retention/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/renewal|candidate|eligible|member/i).first()).toBeVisible(); },
    },
    {
      name: 'view-renewal-queue',
      do: async (p) => { await p.waitForTimeout(1000); },
      expect: async (p, x) => { await x(p.getByText(/member|date|status|action/i).first()).toBeVisible(); },
    },
    {
      name: 'filter-by-readiness',
      do: async (p) => { await p.getByRole('combobox', { name: /readiness|status|filter/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByRole('option').first()).toBeVisible(); },
    },
    {
      name: 'select-member-for-renewal',
      do: async (p) => { await p.getByRole('row').first().click(); },
      expect: async (p, x) => { await x(p.getByText(/member|plan|status|renewal/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'initiate-renewal_outreach',
      do: async (p) => { await p.getByRole('button', { name: /outreach|contact|call|send/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/contacted|reached|scheduled|message/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'document_renewal_outcome',
      do: async (p) => { await p.getByRole('combobox', { name: /outcome|result|status/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByRole('option').first()).toBeVisible(); },
    },
  ],
});
