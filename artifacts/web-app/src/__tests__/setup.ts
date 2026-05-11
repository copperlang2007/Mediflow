/**
 * Vitest setup file.
 *
 * 1. Registers the @testing-library/jest-dom matchers (toBeInTheDocument,
 *    toHaveTextContent, …) on Vitest's `expect`.
 * 2. Wires up a per-test DOM cleanup. RTL only auto-cleans when Vitest is
 *    configured with `globals: true`; since the project keeps globals off,
 *    we have to register `afterEach(cleanup)` ourselves — otherwise mounts
 *    leak across tests and `getByTestId` finds duplicates.
 *
 * For node-environment tests this file is a harmless no-op: jest-dom only
 * augments `expect`, and `cleanup` is a noop when nothing was rendered.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});
