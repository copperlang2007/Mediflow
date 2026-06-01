/**
 * Demo build shim for "@clerk/react/internal".
 *
 * Only `publishableKeyFromHost` is used (App.tsx). Returning a truthy
 * sentinel makes `App()` render the real app shell instead of the
 * "deployment config required" placeholder, without needing a Clerk key.
 * Swapped in only in demo builds (see vite.config.ts).
 */
export function publishableKeyFromHost(
  _host?: string,
  _fallback?: string,
): string {
  return "pk_demo";
}
