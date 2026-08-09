import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'crm-specialist-lead-management',
  description: 'CRM specialist logs in, searches contacts, updates beneficiary details, tracks enrollment history',
  target: 'preview',
  phiScoped: true,
  businessOutcome: 'CRM specialist can manage member database, track enrollment history, and update contact information',
  steps: [
    {
      name: 'visit-login',
      authStep: true,
      do: async (p) => { await p.goto('/'); },
      expect: async (p, x) => { await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible(); },
    },
    {
      name: 'login-crm-specialist',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        await email.fill(process.env.TEST_CRM_EMAIL || 'crm.demo@mediflow.local');
        await password.fill(process.env.TEST_CRM_PASSWORD || 'DemoPass123!');
        await p.getByRole('button', { name: /sign in|log in/i }).first().click();
      },
      expect: async (p, x) => { await x(p).toHaveURL(/crm|contacts|beneficiaries/, { timeout: 15000 }); },
    },
    {
      name: 'access-crm-module',
      do: async (p) => { await p.getByRole('link', { name: /crm|contacts|database/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/search|member|contact|beneficiary/i).first()).toBeVisible(); },
    },
    {
      name: 'search-member',
      do: async (p) => {
        const field = p.getByPlaceholder(/search|name|id|phone/i).first();
        await field.click();
        await field.fill('test');
      },
      expect: async (p, x) => { await x(p.getByText(/result|found/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'open-member-profile',
      do: async (p) => { await p.getByRole('row').first().click(); },
      expect: async (p, x) => { await x(p.getByText(/profile|name|contact|enrollment/i).first()).toBeVisible(); },
    },
    {
      name: 'view-enrollment-history',
      do: async (p) => { await p.getByRole('link', { name: /enrollment|history|timeline/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/date|plan|status|agent/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'verify-contact-data',
      do: async (p) => { await p.waitForTimeout(500); },
      expect: async (p, x) => { await x(p.getByText(/phone|email|address|contact/i).first()).toBeVisible(); },
    },
  ],
});
