/**
 * Demo build shim for "@clerk/themes".
 *
 * App.tsx imports `shadcn` for Clerk's appearance config. In demo builds the
 * Clerk components are inert shims, so the theme object is unused — an empty
 * object keeps the import resolvable. Swapped in only in demo builds.
 */
export const shadcn = {};
