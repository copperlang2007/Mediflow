# 7. Audit exception: `braces` (GHSA-vfj7-8cjw-p6xm) via `http-proxy-middleware`

## Status

Accepted — 2026-10-04. Revisit when a patched `braces` release ships, or if
`clerkProxyMiddleware` ever gains a `pathFilter`.

## Context

`main` CI went red on the `pnpm audit (moderate)` job. The new finding is a
high-severity stack-exhaustion DoS in `braces <=3.0.3` (GHSA-vfj7-8cjw-p6xm),
reached only through:

```
artifacts__api-server > http-proxy-middleware@3.0.7 > micromatch > braces
```

The advisory lists **no patched version**, so a `pnpm.overrides` bump is not
possible. Every other path to `braces` is dev-only and absent from the audit.

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
`pathFilter`, or any other runtime dependency on `micromatch`/`braces` appears
in `pnpm audit` paths. Remove the entry from `ignoreGhsas` when either happens
or when a fixed `braces` is published.

## Reversibility

Easy — one array entry.
