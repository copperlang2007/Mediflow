import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Paths here resolve relative to THIS config file (runner/), not the repo
  // root — hence the ../ prefixes.
  testDir: '../journeys',
  fullyParallel: false, // Serial execution for clean recordings
  workers: 1,
  timeout: 120 * 1000, // 2 min per test
  expect: { timeout: 30 * 1000 },

  retries: 0, // Evidence runs don't retry — capture failures as-is
  reporter: [
    ['html', { outputFolder: '../evidence/html-report' }],
    ['json', { outputFile: '../evidence/results.json' }],
  ],

  use: {
    baseURL: process.env.EVIDENCE_BASE_URL || 'http://localhost:5000',
    headless: process.env.EVIDENCE_HEADED === '1' ? false : true,
    // Video is recorded via each wrapper's recordVideo context option.
    // Tracing is owned by runJourney (manual start/stop into the evidence
    // dir) — trace:'on' here would double-start tracing on the manually
    // created contexts and silently kill every trace.zip.
    video: 'on',
    trace: 'off',
    screenshot: 'on',
    actionTimeout: 15 * 1000,
    navigationTimeout: 30 * 1000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Evidence-grade video config: 1280x720 @ 30fps
        video: { mode: 'on', size: { width: 1280, height: 720 } },
      },
    },
  ],

  // Optional: pre-configure if you have a web server to start
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:5000',
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120 * 1000,
  // },
});
