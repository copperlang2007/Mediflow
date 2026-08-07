import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './03-admin-compliance.journey';

test('admin-compliance', async ({ browser }) => {
  const context = await browser.newContext({
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  });

  try {
    const evidenceDir = path.join(process.cwd(), 'evidence', `03-admin-compliance-${Date.now()}`);
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
