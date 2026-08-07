import { test } from '@playwright/test';
import * as path from 'path';
import { runJourney } from '../runner/journey';
import journey from './01-agent-enrollment-aep.journey';

test('agent-enrollment-aep', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    recordVideo: { dir: `./evidence/01-agent-enrollment-aep-${Date.now()}` },
  });

  try {
    const evidenceDir = path.join(process.cwd(), 'evidence', `01-agent-enrollment-aep-${Date.now()}`);
    await runJourney(journey, context, evidenceDir);
  } finally {
    await context.close();
  }
});
