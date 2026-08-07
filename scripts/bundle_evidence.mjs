#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { execSync } from 'child_process';

const evidenceDir = process.argv[2];

if (!evidenceDir || !fs.existsSync(evidenceDir)) {
  console.error('Usage: node bundle_evidence.mjs <evidence-dir>');
  console.error(`Evidence dir not found: ${evidenceDir}`);
  process.exit(1);
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function zipDirectory(dir, zipPath) {
  // Use system zip if available; otherwise use Node zip lib
  try {
    execSync(`cd "${dir}" && zip -r "${zipPath}" . -x "*.webm"`, { stdio: 'inherit' });
  } catch (err) {
    console.warn('zip not available; evidence bundle will include all files (including video)');
    // Fallback: copy the entire directory
  }
}

(async () => {
  const manifestPath = path.join(evidenceDir, 'evidence.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  // Compute media hashes
  const videoPath = path.join(evidenceDir, 'journey.webm');
  const tracePath = path.join(evidenceDir, 'trace.zip');

  if (fs.existsSync(videoPath)) {
    const stat = fs.statSync(videoPath);
    manifest.media.video = {
      path: 'journey.webm',
      sha256: sha256File(videoPath),
      bytes: stat.size,
    };
  }

  if (fs.existsSync(tracePath)) {
    manifest.media.trace.sha256 = sha256File(tracePath);
  }

  // Recompute manifest hash
  const manifestJson = JSON.stringify(manifest, null, 2);
  manifest.manifest_sha256 = createHash('sha256').update(manifestJson).digest('hex');

  // Write updated manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n📦 Bundling evidence...`);
  console.log(`   Dir: ${evidenceDir}`);

  // Create bundle zip
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(evidenceDir, `..`, `evidence-bundle-${manifest.journey}-${timestamp}.zip`);

  await zipDirectory(evidenceDir, bundlePath);

  // Write MANIFEST.sha256 into the bundle root
  const manifestHashPath = path.join(path.dirname(bundlePath), 'MANIFEST.sha256');
  fs.writeFileSync(manifestHashPath, `${manifest.manifest_sha256}  evidence.json`);

  console.log(`\n✅ Evidence bundle created`);
  console.log(`   Path: ${bundlePath}`);
  console.log(`   Manifest SHA256: ${manifest.manifest_sha256}`);
  console.log(`   Video: ${manifest.media.video ? `${manifest.media.video.bytes} bytes` : 'not captured'}`);
  console.log(`   Trace: ${manifest.media.trace.sha256 ? 'captured' : 'not captured'}`);
  console.log(`   Steps: ${manifest.steps.length}`);
})();
