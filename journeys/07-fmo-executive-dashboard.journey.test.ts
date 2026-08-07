import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './07-fmo-executive-dashboard.journey';

test('fmo-executive-dashboard', async ({ browser }) => {
  const context = await browser.newContext({
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  });

  try {
    const evidenceDir = path.join(process.cwd(), 'evidence', `07-fmo-executive-dashboard-${Date.now()}`);
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
