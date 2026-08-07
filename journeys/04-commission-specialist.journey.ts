import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'commission-specialist-reconciliation',
  description: 'Commission specialist logs in, reviews commission statements, reconciles discrepancies, exports reports',
  target: 'preview',
  phiScoped: false,
  businessOutcome: 'Commission specialist can review and reconcile agent commissions with source data',
  steps: [
    {
      name: 'visit-login',
      do: async (p) => { await p.goto('/'); },
      expect: async (p, x) => { await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible(); },
    },
    {
      name: 'login-commission-specialist',
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        await email.fill(process.env.TEST_COMMISSION_EMAIL || 'commission.demo@mediflow.local');
        await password.fill(process.env.TEST_COMMISSION_PASSWORD || 'DemoPass123!');
        await p.getByRole('button', { name: /sign in|log in/i }).first().click();
      },
      expect: async (p, x) => { await x(p).toHaveURL(/commissions|statement|dashboard/, { timeout: 15000 }); },
    },
    {
      name: 'access-commission-dashboard',
      do: async (p) => { await p.getByRole('link', { name: /commission|statement|payment/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/commission|amount|agent|date/i)).toBeVisible(); },
    },
    {
      name: 'filter-by-period',
      do: async (p) => { await p.getByRole('combobox', { name: /period|month|year|date/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByRole('option')).toBeVisible(); },
    },
    {
      name: 'view-agent-commissions',
      do: async (p) => { await p.getByRole('row').first().click(); },
      expect: async (p, x) => { await x(p.getByText(/commission|amount|details|breakdown/i)).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'review-commission-detail',
      do: async (p) => { await p.waitForTimeout(500); },
      expect: async (p, x) => { await x(p.getByText(/enrollment|plan|amount|date/i)).toBeVisible(); },
    },
    {
      name: 'export-commission-report',
      do: async (p) => { await p.getByRole('button', { name: /export|download|report|csv/i }).first().click(); },
      expect: async (p, x) => { await p.waitForTimeout(1500); },
    },
  ],
});
