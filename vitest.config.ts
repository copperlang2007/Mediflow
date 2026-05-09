import { defineConfig } from "vitest/config";

// Workspace-level vitest config. Test files live next to the modules they
// exercise (under `__tests__` directories) so each package keeps tests
// colocated with code, but a single root command (`pnpm test`) runs them all.
export default defineConfig({
  test: {
    include: [
      "artifacts/**/__tests__/**/*.test.ts",
      "lib/**/__tests__/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
    ],
    environment: "node",
    globals: false,
  },
});
