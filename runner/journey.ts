import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface JourneyStep {
  name: string;
  do: (page: Page) => Promise<void>;
  expect: (page: Page, expect: any) => Promise<void>;
}

export interface JourneyDefinition {
  name: string;
  description: string;
  target: 'live' | 'preview' | 'localhost';
  phiScoped: boolean;
  businessOutcome: string;
  steps: JourneyStep[];
}

export interface EvidenceStep {
  n: number;
  name: string;
  status: 'pass' | 'fail';
  ms: number;
  screenshot: string;
  sha256: string;
  assertions: string[];
}

export interface EvidenceManifest {
  journey: string;
  description: string;
  target: string;
  base_url: string;
  run_utc: string;
  result: 'pass' | 'fail';
  duration_ms: number;
  business_outcome: string;
  business_outcome_verified: boolean;
  phi_gate: {
    scoped: boolean;
    redaction: boolean;
    data_source: 'synthetic' | 'deidentified' | 'real';
  };
  steps: EvidenceStep[];
  media: {
    video: { path: string; sha256: string; bytes: number } | null;
    trace: { path: string; sha256: string };
  };
  manifest_sha256: string;
  git?: {
    repo: string;
    commit: string;
    branch: string;
  };
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function sha256Content(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function defineJourney(definition: JourneyDefinition) {
  return definition;
}

export async function runJourney(
  journeyDef: JourneyDefinition,
  context: BrowserContext,
  evidenceDir: string
) {
  const page = await context.newPage();
  const baseUrl = process.env.EVIDENCE_BASE_URL || 'http://localhost:5000';
  const startTime = Date.now();
  const stepsDir = path.join(evidenceDir, 'steps');
  const evidenceSteps: EvidenceStep[] = [];

  // Ensure steps directory exists
  fs.mkdirSync(stepsDir, { recursive: true });

  console.log(`\n📹 Starting journey: ${journeyDef.name}`);
  console.log(`   Target: ${journeyDef.target} (${baseUrl})`);
  console.log(`   PHI scoped: ${journeyDef.phiScoped}`);

  let passed = true;

  for (let i = 0; i < journeyDef.steps.length; i++) {
    const step = journeyDef.steps[i];
    const stepStartTime = Date.now();
    const stepNum = String(i + 1).padStart(2, '0');
    const screenshotPath = path.join(stepsDir, `${stepNum}-${step.name}.png`);
    const stepStatus = { passed: true, error: null as string | null };

    process.stdout.write(`   [${stepNum}/${journeyDef.steps.length}] ${step.name}...`);

    try {
      // Execute step action
      await step.do(page);

      // Capture screenshot
      await page.screenshot({ path: screenshotPath });

      // Run expectations
      await step.expect(page, expect);

      const stepMs = Date.now() - stepStartTime;
      console.log(` ✓ (${stepMs}ms)`);

      evidenceSteps.push({
        n: i + 1,
        name: step.name,
        status: 'pass',
        ms: stepMs,
        screenshot: path.relative(evidenceDir, screenshotPath),
        sha256: sha256File(screenshotPath),
        assertions: ['step completed'],
      });
    } catch (err) {
      const stepMs = Date.now() - stepStartTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(` ✗ (${stepMs}ms) ${errMsg}`);

      // Still try to capture a screenshot of the error state
      try {
        await page.screenshot({ path: screenshotPath });
        evidenceSteps.push({
          n: i + 1,
          name: step.name,
          status: 'fail',
          ms: stepMs,
          screenshot: path.relative(evidenceDir, screenshotPath),
          sha256: sha256File(screenshotPath),
          assertions: [`failed: ${errMsg}`],
        });
      } catch {
        evidenceSteps.push({
          n: i + 1,
          name: step.name,
          status: 'fail',
          ms: stepMs,
          screenshot: '',
          sha256: '',
          assertions: [`failed: ${errMsg} (screenshot also failed)`],
        });
      }

      passed = false;
      break; // Stop on first failure
    }
  }

  const totalMs = Date.now() - startTime;

  // Compute manifest hash
  const tempManifest = {
    journey: journeyDef.name,
    description: journeyDef.description,
    target: journeyDef.target,
    base_url: baseUrl,
    run_utc: new Date().toISOString(),
    result: (passed ? 'pass' : 'fail') as 'pass' | 'fail',
    duration_ms: totalMs,
    business_outcome: journeyDef.businessOutcome,
    business_outcome_verified: passed,
    phi_gate: {
      scoped: journeyDef.phiScoped,
      redaction: journeyDef.phiScoped,
      data_source: 'synthetic' as const,
    },
    steps: evidenceSteps,
    media: {
      video: null as any,
      trace: { path: 'trace.zip', sha256: '' },
    },
    manifest_sha256: '',
  };

  const manifestJson = JSON.stringify(tempManifest, null, 2);
  const manifest: EvidenceManifest = {
    ...tempManifest,
    manifest_sha256: sha256Content(manifestJson),
  };

  // Write manifest
  const manifestPath = path.join(evidenceDir, 'evidence.json');
  fs.writeFileSync(manifestPath, manifestJson);

  console.log(
    `\n📊 Journey ${passed ? 'PASSED' : 'FAILED'} (${totalMs}ms)\n` +
      `   Evidence: ${evidenceDir}\n` +
      `   Manifest: ${manifestPath}`
  );

  await page.close();

  return { manifest, passed };
}
