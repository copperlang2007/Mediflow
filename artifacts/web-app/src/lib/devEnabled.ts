/**
 * Client-side gate for the Dev Console UI.
 *
 * The server-side gate (devOnly middleware) is the real security boundary —
 * disabling this constant just hides the nav entries and skips lazy-loading
 * the dev pages. Setting VITE_ENABLE_DEV_CONSOLE=true at build time exposes
 * the UI. The corresponding ENABLE_DEV_CONSOLE=true must be set on the
 * server for the API calls to actually return data.
 *
 * Note: this is a build-time flag — Vite inlines import.meta.env values at
 * bundle time, so a production build with the flag unset will literally
 * not contain the dev page code (lazy chunks won't be referenced).
 *
 * VITE_DEV_CONSOLE_ENABLED is accepted as an alias for backwards-compat
 * with early Phase 1B scaffolding.
 */
export const DEV_CONSOLE_ENABLED =
  import.meta.env.VITE_ENABLE_DEV_CONSOLE === "true" ||
  import.meta.env.VITE_DEV_CONSOLE_ENABLED === "true";
