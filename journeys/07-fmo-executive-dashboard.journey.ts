import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'fmo-executive-dashboard',
  description: 'FMO executive logs in, views dashboard with agency KPIs, reviews enrollment metrics and revenue',
  target: 'preview',
  phiScoped: false,
  businessOutcome: 'FMO executive can view agency-wide performance metrics and enrollment trends',
  steps: [
    {
      name: 'visit-login',
      authStep: true,
      do: async (p) => { await p.goto('/'); },
      expect: async (p, x) => { await x(p.getByRole('heading', { name: /sign in|login/i })).toBeVisible(); },
    },
    {
      name: 'login-fmo-executive',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        await email.fill(process.env.TEST_EXECUTIVE_EMAIL || 'executive.demo@mediflow.local');
        await password.fill(process.env.TEST_EXECUTIVE_PASSWORD || 'DemoPass123!');
        await p.getByRole('button', { name: /sign in|log in/i }).first().click();
      },
      expect: async (p, x) => { await x(p).toHaveURL(/dashboard/, { timeout: 15000 }); },
    },
    {
      name: 'view-dashboard',
      do: async (p) => { await p.waitForTimeout(1500); },
      expect: async (p, x) => { await x(p.getByText(/kpi|metrics|enrollment|revenue/i).first()).toBeVisible(); },
    },
    {
      name: 'inspect-kpi-cards',
      do: async (p) => { await p.waitForTimeout(500); },
      expect: async (p, x) => { await x(p.getByText(/total|average|growth|decline/i).first()).toBeVisible(); },
    },
    {
      name: 'view-enrollment-trends',
      do: async (p) => { await p.getByText(/enrollment|trend|chart|graph/i).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/month|quarter|period|plan/i).first()).toBeVisible({ timeout: 10000 }); },
    },
    {
      name: 'view-agent-performance',
      do: async (p) => { await p.getByRole('link', { name: /agent|performance|leaderboard/i }).first().click(); },
      expect: async (p, x) => { await x(p.getByText(/agent|name|enrollments|performance/i).first()).toBeVisible(); },
    },
    {
      name: 'verify-business-metrics',
      do: async (p) => { await p.waitForTimeout(500); },
      expect: async (p, x) => { await x(p.getByText(/commission|revenue|payout/i).first()).toBeVisible(); },
    },
  ],
});
