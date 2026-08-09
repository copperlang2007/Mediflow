import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface JourneyStep {
  name: string;
  do: (page: Page) => Promise<void>;
  expect: (page: Page, expect: any) => Promise<void>;
  /** Marks login/sign-in steps. Skipped when EVIDENCE_ASSUME_SIGNED_IN=1 —
   *  demo deployments (VITE_DEMO_MODE) swap the auth provider for a shim
   *  that is always signed in and renders no login form at all. */
  authStep?: boolean;
  /** Human-readable descriptions of what this step's expect() verifies —
   *  recorded verbatim in the evidence manifest so an auditor can tell WHAT
   *  a passing step proved, not merely that it didn't throw. */
  assertionLabels?: string[];
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
  status: 'pass' | 'fail' | 'skipped';
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
    video: {
      path: string;
      sha256: string;
      bytes: number;
      /** Set by bundle_evidence.mjs when the bundle zip excludes the webm —
       *  the hash then verifies the out-of-band video file. */
      excluded_from_bundle?: boolean;
    } | null;
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

  // The runner records raw media — it performs NO redaction. A PHI-scoped
  // journey against real data would therefore capture PHI into screenshots
  // and video, so refuse outright. Operators declare the target's data
  // class via EVIDENCE_DATA_SOURCE (default: synthetic).
  const dataSource = (process.env.EVIDENCE_DATA_SOURCE || 'synthetic') as
    | 'synthetic'
    | 'deidentified'
    | 'real';
  if (journeyDef.phiScoped && dataSource === 'real') {
    throw new Error(
      `Journey '${journeyDef.name}' is phiScoped but EVIDENCE_DATA_SOURCE=real: ` +
        'the evidence runner does not redact media — refusing to record. ' +
        'Point EVIDENCE_BASE_URL at a synthetic/deidentified dataset.',
    );
  }
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
  const assumeSignedIn = process.env.EVIDENCE_ASSUME_SIGNED_IN === '1';
  let skippedAuth = false;

  for (let i = 0; i < journeyDef.steps.length; i++) {
    const step = journeyDef.steps[i];

    if (assumeSignedIn && step.authStep) {
      console.log(`   [${String(i + 1).padStart(2, '0')}/${journeyDef.steps.length}] ${step.name}... ⤳ skipped (EVIDENCE_ASSUME_SIGNED_IN)`);
      evidenceSteps.push({
        n: i + 1,
        name: step.name,
        status: 'skipped',
        ms: 0,
        screenshot: '',
        sha256: '',
        assertions: ['skipped: target is a signed-in (demo-mode) deployment'],
      });
      skippedAuth = true;
      continue;
    }
    if (skippedAuth) {
      // Land the signed-in session on the app root once; the SPA redirects
      // to its authenticated landing page from here.
      skippedAuth = false;
      await page.goto('/');
    }

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
        // Step-specific evidence, not a boilerplate literal: authors describe
        // what their expect() verified via assertionLabels; the fallback at
        // least names WHICH step's expect held.
        assertions: step.assertionLabels?.length
          ? step.assertionLabels
          : [`expect(${step.name}) passed`],
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

  // A journey passes only when its steps AND its business-outcome assertion
  // (when defined) hold — a green result must never outrank the outcome gate.
  const overall = passed && outcomeVerified;

  const manifest: EvidenceManifest = {
    journey: journeyDef.name,
    description: journeyDef.description,
    target: journeyDef.target,
    base_url: baseUrl,
    run_utc: new Date().toISOString(),
    result: overall ? 'pass' : 'fail',
    duration_ms: totalMs,
    business_outcome: journeyDef.businessOutcome,
    business_outcome_verified: outcomeVerified,
    business_outcome_method: hasOutcomeAssertion ? 'explicit-assertion' : 'all-steps-passed',
    phi_gate: {
      scoped: journeyDef.phiScoped,
      // The runner does not scrub media, so the manifest must not attest a
      // redaction control that was never applied. This stays false until a
      // real media-redaction pass exists.
      redaction: false,
      data_source: dataSource,
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
    `\n📊 Journey ${overall ? 'PASSED' : 'FAILED'} (${totalMs}ms)\n` +
      `   Evidence: ${evidenceDir}\n` +
      `   Manifest: ${manifestPath}`
  );

  // The manifest above is the evidence record; this throw is the CI signal.
  // Without it Playwright reports every journey green regardless of outcome.
  if (!overall) {
    throw new Error(
      `Journey '${journeyDef.name}' failed — steps=${passed ? 'pass' : 'fail'} ` +
        `outcome=${outcomeVerified ? 'pass' : 'fail'}. See ${manifestPath}`,
    );
  }

  return { manifest, passed: overall };
}
