# agencyBRIDGE

agencyBRIDGE is a pnpm monorepo for a Medicare agency management platform. It includes API, web app, mockup sandbox, E2E tests, load tests, and compliance-focused integration tests.

## Stack

- Node.js 24
- pnpm 10
- TypeScript 5.9
- Vite and React
- Vitest and Playwright

## Verify

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

The repository also includes a dependency-free quality smoke test:

```bash
node --test tests/*.test.mjs
```
