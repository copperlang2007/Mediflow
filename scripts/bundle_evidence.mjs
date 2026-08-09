#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

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

function zipDirectory(dir, zipPath) {
  // spawnSync with array args — paths are never interpreted by a shell.
  // The zip is created inside `dir` under its basename, then moved to zipPath,
  // so `zip` never has to resolve a path outside its working directory.
  const zipName = path.basename(zipPath);
  const result = spawnSync('zip', ['-r', zipName, '.', '-x', '*.webm'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.warn('zip failed or not installed; no bundle zip was created');
    return false;
  }
  fs.renameSync(path.join(dir, zipName), zipPath);
  return true;
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
      // The bundle zip deliberately excludes *.webm (size); the hash lets a
      // verifier check the out-of-band video without the manifest signing a
      // file the archive claims to contain.
      excluded_from_bundle: true,
      sha256: sha256File(videoPath),
      bytes: stat.size,
    };
  }

  if (fs.existsSync(tracePath)) {
    manifest.media.trace.sha256 = sha256File(tracePath);
  }

  // Recompute manifest hash. Convention: the hash covers the manifest
  // serialized with manifest_sha256 blanked — verifiers blank the field,
  // re-serialize, and compare against the recorded value.
  manifest.manifest_sha256 = '';
  const canonicalJson = JSON.stringify(manifest, null, 2);
  manifest.manifest_sha256 = createHash('sha256').update(canonicalJson).digest('hex');

  // Write updated manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n📦 Bundling evidence...`);
  console.log(`   Dir: ${evidenceDir}`);

  // Create bundle zip
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(evidenceDir, `..`, `evidence-bundle-${manifest.journey}-${timestamp}.zip`);

  // Write MANIFEST.sha256 into the evidence dir BEFORE zipping so the
  // sidecar hash lands in the archive root.
  const manifestHashPath = path.join(evidenceDir, 'MANIFEST.sha256');
  fs.writeFileSync(manifestHashPath, `${manifest.manifest_sha256}  evidence.json\n`);

  zipDirectory(evidenceDir, bundlePath);

  console.log(`\n✅ Evidence bundle created`);
  console.log(`   Path: ${bundlePath}`);
  console.log(`   Manifest SHA256: ${manifest.manifest_sha256}`);
  console.log(`   Video: ${manifest.media.video ? `${manifest.media.video.bytes} bytes` : 'not captured'}`);
  console.log(`   Trace: ${manifest.media.trace.sha256 ? 'captured' : 'not captured'}`);
  console.log(`   Steps: ${manifest.steps.length}`);
})();
