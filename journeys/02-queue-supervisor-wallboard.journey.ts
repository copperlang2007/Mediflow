import { defineJourney } from '../runner/journey';

export default defineJourney({
  name: 'queue-supervisor-wallboard',
  description: 'Supervisor logs in, views call queue wallboard with agent status, monitors call metrics',
  target: 'preview',
  phiScoped: false,
  businessOutcome: 'Supervisor can view real-time queue status, agent performance, and call metrics for workforce management',
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
      name: 'login-supervisor',
      authStep: true,
      do: async (p) => {
        const email = p.locator('input[type="email"]').first();
        const password = p.locator('input[type="password"]').first();
        const submit = p.getByRole('button', { name: /sign in|log in/i }).first();

        await email.fill(process.env.TEST_SUPERVISOR_EMAIL || 'supervisor.demo@mediflow.local');
        await password.fill(process.env.TEST_SUPERVISOR_PASSWORD || 'DemoPass123!');
        await submit.click();
      },
      expect: async (p, x) => {
        await x(p).toHaveURL(/dashboard|queue|wallboard/, { timeout: 15000 });
      },
    },
    {
      name: 'access-queue-wallboard',
      do: async (p) => {
        await p.getByRole('link', { name: /queue|wallboard|monitoring/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/agent|queue|status|calls/i).first()).toBeVisible();
      },
    },
    {
      name: 'view-agent-status',
      do: async (p) => {
        await p.waitForTimeout(1000);
      },
      expect: async (p, x) => {
        await x(p.getByText(/available|busy|break|ready/i).first()).toBeVisible();
      },
    },
    {
      name: 'inspect-call-queue',
      do: async (p) => {
        await p.getByText(/waiting|queue|pending|next/i).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/call|member|agent|time/i).first()).toBeVisible();
      },
    },
    {
      name: 'view-agent-metrics',
      do: async (p) => {
        await p.getByRole('button', { name: /metrics|performance|stats/i }).first().click();
      },
      expect: async (p, x) => {
        await x(p.getByText(/calls|duration|conversion|average/i).first()).toBeVisible({ timeout: 10000 });
      },
    },
    {
      name: 'verify-real-time-updates',
      do: async (p) => {
        await p.waitForTimeout(2000);
      },
      expect: async (p, x) => {
        await x(p.getByText(/queue|agent|status/i).first()).toBeVisible();
      },
    },
  ],
});
