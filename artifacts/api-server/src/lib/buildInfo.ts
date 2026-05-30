/**
 * Build/release metadata, read once from the environment at module-load.
 *
 * Surfaces the running deploy's identity so:
 *   - Sentry events tie to the right release (stack-trace symbolication +
 *     "first seen in" / "fixed in" tracking).
 *   - Ops can debug-by-curl via the `X-Build-Sha` response header that
 *     `middlewares/buildShaHeader.ts` sets on every response.
 *   - The `/version` endpoint gives a JSON shape for monitoring probes.
 *
 * Env contract (none are required — sensible defaults keep dev / test
 * frictionless):
 *
 *   APP_VERSION     — semver string, e.g. "1.4.2". Falls back to
 *                     "0.0.0-dev". Set this in your deploy pipeline from
 *                     `package.json`'s version field or a tag.
 *
 *   BUILD_SHA       — git commit SHA the artifact was built from.
 *                     Cascades to GITHUB_SHA (set by GitHub Actions),
 *                     then SENTRY_RELEASE, then "unknown".
 *
 *   BUILD_TIME      — ISO-8601 timestamp of build. Optional.
 *
 * Why env-driven and not `import "../../package.json"`: the esbuild
 * bundle (build.mjs) inlines source at build time, but the version
 * stamp is more useful when it tracks the deploy artifact, not the
 * commit-time source. Deploy pipelines set these vars per-environment.
 */

export interface BuildInfo {
  /** Semver from APP_VERSION, or "0.0.0-dev" if unset. */
  version: string;
  /**
   * Git SHA the artifact was built from. Used as the Sentry `release`
   * identifier so events bucket per-deploy. "unknown" when no env hint
   * is available (local dev, untagged builds).
   */
  sha: string;
  /** ISO-8601 build timestamp, or null when BUILD_TIME is unset. */
  builtAt: string | null;
  /** node --version equivalent, e.g. "v24.0.0". */
  nodeVersion: string;
}

let _cached: BuildInfo | undefined;

function readSha(): string {
  // Cascade: explicit BUILD_SHA → GitHub Actions default → Sentry CLI
  // convention → final fallback. The cascade lets the same code work
  // whether the deploy pipeline is GH Actions, a manual script that
  // sets SENTRY_RELEASE, or a local-dev run with no env at all.
  return (
    process.env.BUILD_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.SENTRY_RELEASE?.trim() ||
    "unknown"
  );
}

/**
 * Resolved, cached build metadata. Reading env at every call site would
 * defeat the deploy-pipeline contract — env vars shouldn't drift mid-
 * process. The cache fixes the snapshot at first read (typically Sentry
 * init at module-load time).
 */
export function getBuildInfo(): BuildInfo {
  if (_cached) return _cached;
  _cached = {
    version: process.env.APP_VERSION?.trim() || "0.0.0-dev",
    sha: readSha(),
    builtAt: process.env.BUILD_TIME?.trim() || null,
    nodeVersion: process.version,
  };
  return _cached;
}

/** Test helper — clears the cache so a fresh env can be observed. */
export function _resetBuildInfoCacheForTests(): void {
  _cached = undefined;
}
