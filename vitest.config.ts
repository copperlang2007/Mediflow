import { defineConfig } from "vitest/config";
import path from "node:path";

// Workspace-level vitest config. Test files live next to the modules they
// exercise (under `__tests__` directories) so each package keeps tests
// colocated with code, but a single root command (`pnpm test`) runs them all.
//
// The default environment is `node` because most of our tests are pure helpers
// or API integration tests against pglite. React component tests opt into
// jsdom on a per-file basis with the `// @vitest-environment jsdom` docblock
// at the top of the file — that keeps the config simple and pins the cost of
// jsdom to the handful of files that actually need it.
export default defineConfig({
  // Use the automatic JSX runtime so React component tests don't need to
  // `import React` at the top of every file. Vitest hands JSX off to esbuild
  // for transpile (it does not load Vite plugins by default), so we tell
  // esbuild explicitly.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      // Mirror the `@/*` alias from artifacts/web-app/tsconfig.json so React
      // tests can import components with the same path they use in source.
      "@": path.resolve(__dirname, "artifacts/web-app/src"),
    },
  },
  test: {
    include: [
      "artifacts/**/__tests__/**/*.test.ts",
      "artifacts/**/__tests__/**/*.test.tsx",
      "lib/**/__tests__/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
    ],
    environment: "node",
    globals: false,
    // Registers the @testing-library/jest-dom matchers (toBeInTheDocument, …)
    // for any test file that opts into the jsdom environment. The setup file
    // is a no-op for node-environment tests since it only extends `expect`.
    setupFiles: ["artifacts/web-app/src/__tests__/setup.ts"],
    // Integration tests boot a pglite instance per file. The boot restores a
    // pre-migrated snapshot (see __tests__/helpers/testDb.ts) rather than
    // replaying every migration, so a boot is ~0.5s of bulk in-memory load.
    // 30s is already generous; the snapshot is the real flake fix. The 60s
    // hookTimeout is only a backstop for a pathologically loaded CI runner.
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: {
      forks: {
        // Bound worker count so a CI box with few cores can't oversubscribe
        // the CPU badly enough to starve a boot hook. The snapshot restore is
        // cheap, but capping fan-out keeps the safety margin wide.
        maxForks: 4,
        minForks: 1,
      },
    },
  },
});
