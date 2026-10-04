// Executable tripwire for ADR 0007 (GHSA-vfj7-8cjw-p6xm in `braces`).
//
// `pnpm.auditConfig.ignoreGhsas` suppresses an advisory by id on every path,
// so `pnpm audit` alone would stay green if the exception stopped being safe.
// These tests fail the moment either invalidation condition in the ADR occurs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

// Packages allowed to depend on micromatch/braces, as reviewed in ADR 0007.
// fast-glob is build tooling; http-proxy-middleware only calls micromatch for
// glob pathFilters, which we never pass.
const REVIEWED_CONSUMERS = [
  "fast-glob",
  "http-proxy-middleware",
  "micromatch",
];

function consumersInLockfile() {
  const lines = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  const start = lines.indexOf("snapshots:");
  assert.notEqual(start, -1, "pnpm-lock.yaml has no snapshots: section");
  const found = new Set();
  let pkg = null;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) pkg = line.trim().replace(/:$/, "");
    else if (pkg && /^ {6}(braces|micromatch):/.test(line)) {
      // "name@1.2.3" or "@scope/name@1.2.3(peer)" -> package name
      found.add(pkg.replace(/^'|'$/g, "").match(/^(@?[^@]+)@/)[1]);
    }
  }
  return [...found].sort();
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("ADR 0007 audit exception tripwire", () => {
  it("only reviewed packages depend on micromatch or braces", () => {
    assert.deepEqual(
      consumersInLockfile(),
      REVIEWED_CONSUMERS,
      "A new package depends on micromatch/braces. Re-review ADR 0007 before " +
        "keeping GHSA-vfj7-8cjw-p6xm in ignoreGhsas.",
    );
  });

  it("no http-proxy-middleware call passes a pathFilter", () => {
    const offenders = sourceFiles(join(ROOT, "artifacts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes("http-proxy-middleware") && /\bpathFilter\b/.test(src);
      })
      .map((f) => f.slice(ROOT.length));
    assert.deepEqual(
      offenders,
      [],
      "A pathFilter reaches micromatch/braces. ADR 0007's exception no longer " +
        "holds; remove GHSA-vfj7-8cjw-p6xm from ignoreGhsas.",
    );
  });
});
