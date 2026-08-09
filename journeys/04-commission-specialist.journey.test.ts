import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './04-commission-specialist.journey';

test('commission-specialist', async ({ browser }) => {
  const evidenceDir = path.join(process.cwd(), 'evidence', `04-commission-specialist-${Date.now()}`);
  const context = await browser.newContext({
    recordVideo: { dir: evidenceDir, size: { width: 1280, height: 720 } },
  });

  try {
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
