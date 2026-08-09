import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './08-renewals-retention-specialist.journey';

test('renewals-retention-specialist', async ({ browser }) => {
  const evidenceDir = path.join(process.cwd(), 'evidence', `08-renewals-retention-specialist-${Date.now()}`);
  const context = await browser.newContext({
    recordVideo: { dir: evidenceDir, size: { width: 1280, height: 720 } },
  });

  try {
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
