/**
 * True only in demo builds (`VITE_DEMO_MODE=true`, see vite.config.ts and
 * render.yaml). Production builds set no such flag, so this is a constant
 * `false` there and any demo-only UI is dead code.
 */
export const IS_DEMO_BUILD =
  (import.meta.env as Record<string, string | undefined>).VITE_DEMO_MODE === "true";
