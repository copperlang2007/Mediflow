import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'admin-compliance-verification',
  description: 'Compliance admin logs in, reviews compliance dashboard, verifies licensing status, exports audit report',
  target: 'preview',
  phiScoped: false,
  businessOutcome: 'Compliance admin can verify agency licensing compliance and export evidence for regulatory audits',
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
      name: 'login-compliance-admin',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        const submit = p.getByRole('button', { name: /sign in|log in/i }).first();

        await email.fill(process.env.TEST_COMPLIANCE_ADMIN_EMAIL || 'compliance.demo@mediflow.local');
        await password.fill(process.env.TEST_COMPLIANCE_ADMIN_PASSWORD || 'DemoPass123!');
        await submit.click();
      },
      expect: async (p, x) => {
        await x(p).toHaveURL(/dashboard|admin|compliance/, { timeout: 15000 });
      },
    },
    {
      name: 'access-compliance-dashboard',
      do: async (p) => {
        await p.getByRole('link', { name: /compliance|admin/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/compliance|status|audit|verified/i).first()).toBeVisible();
      },
    },
    {
      name: 'view-licensing-status',
      do: async (p) => {
        await p.getByRole('link', { name: /licensing|license|certifications/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/license|active|expired|status/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'verify-agent-credentials',
      do: async (p) => {
        await p.getByRole('link', { name: /agents|credentials|certifications/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/agent|name|status|verified/i).first()).toBeVisible();
      },
    },
    {
      name: 'inspect-agent-record',
      do: async (p) => {
        await p.getByRole('row').first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/license|certification|status|date/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'export-compliance-report',
      do: async (p) => {
        await p.getByRole('button', { name: /export|download|report|audit/i }).first().click();
      },
      expect: async (p, x) => {
        await p.waitForTimeout(1500);
      },
    },
    {
      name: 'verify-audit-trail',
      do: async (p) => {
        await p.getByText(/audit|history|log|changes/i).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/timestamp|action|user|change/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
  ],
});
