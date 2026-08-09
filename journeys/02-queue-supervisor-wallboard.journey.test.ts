import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './02-queue-supervisor-wallboard.journey';

test('queue-supervisor-wallboard', async ({ browser }) => {
  const evidenceDir = path.join(process.cwd(), 'evidence', `02-queue-supervisor-wallboard-${Date.now()}`);
  // Manually-created contexts do NOT inherit the config's use.baseURL —
  // without an explicit baseURL every page.goto('/') fails as an invalid URL.
  const context = await browser.newContext({
    baseURL: process.env.EVIDENCE_BASE_URL || 'http://localhost:5000',
    recordVideo: { dir: evidenceDir, size: { width: 1280, height: 720 } },
  });

  try {
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
