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
  /** Optional terminal assertion proving the BUSINESS outcome specifically —
   *  distinct from step expects, which only prove the steps ran. When present,
   *  business_outcome_verified reflects THIS assertion; when absent, the
   *  manifest records that verification was steps-only. */
  businessOutcomeAssertion?: (page: Page, expect: any) => Promise<void>;
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
  /** 'explicit-assertion': a dedicated businessOutcomeAssertion passed.
   *  'all-steps-passed': no dedicated assertion exists; verified only means
   *  every step's expect held — a weaker claim, stated as such. */
  business_outcome_method: 'explicit-assertion' | 'all-steps-passed';
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

  // Trace lands in the evidence dir under the name the bundler expects.
  let tracing = true;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
  } catch {
    tracing = false; // context may already be tracing (e.g. under the Playwright config's trace:'on')
  }

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

  // Business-outcome gate: run the dedicated assertion (if defined) after the
  // steps, before media finalization, so its result lands in the manifest.
  let outcomeVerified = passed;
  const hasOutcomeAssertion = typeof journeyDef.businessOutcomeAssertion === 'function';
  if (passed && hasOutcomeAssertion) {
    try {
      await journeyDef.businessOutcomeAssertion!(page, expect);
    } catch (err) {
      outcomeVerified = false;
      console.log(`   ✗ business outcome assertion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const totalMs = Date.now() - startTime;

  // Finalize media BEFORE the manifest so their hashes can be recorded in it.
  const tracePath = path.join(evidenceDir, 'trace.zip');
  if (tracing) {
    try {
      await context.tracing.stop({ path: tracePath });
    } catch {
      /* trace is best-effort evidence; its absence shows as an empty hash */
    }
  }

  const pageVideo = page.video();
  await page.close();

  // Playwright writes the recording under a random name in recordVideo.dir;
  // give it the stable name the manifest and bundler expect. saveAs waits for
  // the recording to be fully written.
  const videoPath = path.join(evidenceDir, 'journey.webm');
  let video: EvidenceManifest['media']['video'] = null;
  if (pageVideo) {
    try {
      await pageVideo.saveAs(videoPath);
      await pageVideo.delete();
      video = {
        path: 'journey.webm',
        sha256: sha256File(videoPath),
        bytes: fs.statSync(videoPath).size,
      };
    } catch {
      video = null; // context was created without recordVideo
    }
  }

  const manifest: EvidenceManifest = {
    journey: journeyDef.name,
    description: journeyDef.description,
    target: journeyDef.target,
    base_url: baseUrl,
    run_utc: new Date().toISOString(),
    result: passed ? 'pass' : 'fail',
    duration_ms: totalMs,
    business_outcome: journeyDef.businessOutcome,
    business_outcome_verified: outcomeVerified,
    business_outcome_method: hasOutcomeAssertion ? 'explicit-assertion' : 'all-steps-passed',
    phi_gate: {
      scoped: journeyDef.phiScoped,
      redaction: journeyDef.phiScoped,
      data_source: 'synthetic',
    },
    steps: evidenceSteps,
    media: {
      video,
      trace: { path: 'trace.zip', sha256: fs.existsSync(tracePath) ? sha256File(tracePath) : '' },
    },
    manifest_sha256: '',
  };

  // Hash convention: the hash covers the manifest serialized with
  // manifest_sha256 blanked. Verifiers blank the field, re-serialize with
  // JSON.stringify(manifest, null, 2), and compare.
  manifest.manifest_sha256 = sha256Content(JSON.stringify(manifest, null, 2));

  const manifestPath = path.join(evidenceDir, 'evidence.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `\n📊 Journey ${passed ? 'PASSED' : 'FAILED'} (${totalMs}ms)\n` +
      `   Evidence: ${evidenceDir}\n` +
      `   Manifest: ${manifestPath}`
  );

  // The manifest above is the evidence record; this throw is the CI signal.
  // Without it Playwright reports every journey green regardless of outcome.
  if (!passed) {
    throw new Error(`Journey '${journeyDef.name}' failed — see ${manifestPath}`);
  }

  return { manifest, passed };
}
