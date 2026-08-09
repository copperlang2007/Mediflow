import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'licensing-manager-verification',
  description: 'Licensing manager logs in, reviews agent licenses, verifies expiration dates, flags renewals needed',
  target: 'preview',
  phiScoped: false,
  businessOutcome: 'Licensing manager can track agent licensing status and identify renewal requirements',
  steps: [
    {
      name: 'visit-login',
      authStep: true,
      do: async (p) => { await p.goto('/'); },
      expect: async (p, x) => { await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible(); },
    },
    {
      name: 'login-licensing-manager',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        await email.fill(process.env.TEST_LICENSING_EMAIL || 'licensing.demo@mediflow.local');
        await password.fill(process.env.TEST_LICENSING_PASSWORD || 'DemoPass123!');
        await p.getByRole('button', { name: /sign in|log in/i }).first().click();
      },
      expect: async (p, x) => { await x(p).toHaveURL(/licensing|certifications|admin/, { timeout: 15000 }); },
    },
    {
      name: 'access-licensing-dashboard',
      do: async (p) => { await p.getByRole('link', { name: /licensing|certifications|licenses/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/license|expir|status|certified/i).first()).toBeVisible(); },
    },
    {
      name: 'view-all-agents',
      do: async (p) => { await p.waitForTimeout(1000); },
      expect: async (p, x) => { await x(p.getByText(/agent|name|license|status/i).first()).toBeVisible(); },
    },
    {
      name: 'filter-expiring-licenses',
      do: async (p) => { await p.getByRole('button', { name: /filter|expir|pending/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/expir|renewal/i).first()).toBeVisible(); },
    },
    {
      name: 'inspect-license-record',
      do: async (p) => { await p.getByRole('row').first().click(); },
      expect: async (p, x) => { await x(p.getByText(/license|expir|date|status|action/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'initiate-renewal',
      do: async (p) => { await p.getByRole('button', { name: /renew|reapply|update|extend/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/renewal|submitted|pending/i).first()).toBeVisible({ timeout: 10000 }); },
    },
  ],
});
