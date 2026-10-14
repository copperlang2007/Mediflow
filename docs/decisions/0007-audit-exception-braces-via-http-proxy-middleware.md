# 7. Audit exception: `braces` (GHSA-vfj7-8cjw-p6xm) via `http-proxy-middleware`

## Status

Accepted — 2026-10-04. Revisit when a patched `braces` release ships.

**Update 2026-10-14:** the production path is gone. Moving sign-in to Identity
Platform (ADR 0006) removed `clerkProxyMiddleware` and the
`http-proxy-middleware` dependency, so `braces` is no longer in the API
runtime. The exception stays only for the development-only path
`artifacts/mockup-sandbox > fast-glob > micromatch > braces`, whose glob
patterns are fixed in our code (see Context). Remove the exception when
`braces` ships a fix or the mockup sandbox stops using `fast-glob`.

## Context

`main` CI went red on the `pnpm audit (moderate)` job. The new finding is a
high-severity stack-exhaustion DoS in `braces <=3.0.3` (GHSA-vfj7-8cjw-p6xm),
reached in the production API runtime through
`artifacts__api-server > http-proxy-middleware@3.0.7 > micromatch > braces`.

The advisory lists **no patched version**, so a `pnpm.overrides` bump is not
possible. CI also audits development dependencies, including
`artifacts/mockup-sandbox > fast-glob > micromatch > braces`.
That development-only path uses fixed glob patterns in
`artifacts/mockup-sandbox/mockupPreviewPlugin.ts` and does not introduce
attacker-controlled patterns.

## Analysis — why the vulnerable code is unreachable

1. `braces` expands the **glob pattern**, not the string being matched. The
   attack requires an attacker to control a deeply nested pattern.
2. `http-proxy-middleware` calls `micromatch` only from `matchPathFilter`, and
   only when `pathFilter` is a glob or glob array
   (`dist/path-filter.js`). The pattern is always supplied by our code.
3. `clerkProxyMiddleware()` (`artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts`)
   passes **no `pathFilter`**. It is mounted with
   `app.use(CLERK_PROXY_PATH, clerkProxyMiddleware())`, so the library uses its
   default `'/'` string filter and takes the plain `indexOf` branch —
   `micromatch` is never invoked.
4. The middleware is a no-op unless `NODE_ENV=production` and
   `CLERK_SECRET_KEY` is set.

Request data cannot reach `braces` in this configuration.

## Decision

Add `GHSA-vfj7-8cjw-p6xm` to `pnpm.auditConfig.ignoreGhsas` in the root
`package.json`, keeping `--audit-level=moderate` for everything else.

## Alternatives considered

- **Replace `http-proxy-middleware` with a hand-written proxy.** Removes the
  dependency but rewrites an auth-path component (Clerk FAPI proxy) to clear a
  finding that is not reachable. Higher risk than the exception. Deferred.
- **Lower the audit level to `critical`.** Hides future real findings. Rejected.

## Tripwire

This exception is invalid the moment `clerkProxyMiddleware` passes a glob
`pathFilter`, or another runtime dependency path to `micromatch`/`braces`
is introduced. Review middleware configuration and dependency changes
independently of the configured CI audit. To revalidate advisory paths and
patched-version availability, run the audit with this GHSA entry temporarily
removed from `ignoreGhsas`; the configured audit suppresses this advisory
across all dependency paths. Remove the entry when either condition occurs
or when a fixed `braces` release is published.

`scripts/src/check-braces-audit-exception.ts` (CI step "Verify braces audit
exception", `pnpm --filter @workspace/scripts check:braces-audit-exception`)
enforces this automatically. Since 2026-10-14 (Clerk removed, ADR 0006) it
fails if `@workspace/api-server` has `braces` anywhere in its production
dependency tree, or if `createProxyMiddleware` appears anywhere in API source,
so the exception can never silently cover production code again.

## Reversibility

Easy — one array entry.
