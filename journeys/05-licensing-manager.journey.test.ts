import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './05-licensing-manager.journey';

test('licensing-manager', async ({ browser }) => {
  const evidenceDir = path.join(process.cwd(), 'evidence', `05-licensing-manager-${Date.now()}`);
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
