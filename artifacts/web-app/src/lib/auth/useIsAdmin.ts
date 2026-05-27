/**
 * Shared admin-role gate.
 *
 * Every admin-gated page in the web-app needs to (a) wait for `useGetMe` to
 * resolve, then (b) check whether the current user's role falls within an
 * allowed set. The check itself is one line, but every page was duplicating
 * the same `me && [...].includes(me.role)` pattern with its own hand-rolled
 * role array — which made it easy to drift (e.g. one page accepting
 * `compliance_manager` and another forgetting to). This helper centralises
 * the check and exposes two canonical role tiers so call sites pick a named
 * constant rather than copy a literal array.
 *
 * The server still enforces the real authorisation gate on every endpoint —
 * this is purely a UX helper so non-admin users see a clean "no access"
 * panel instead of an opaque 403 from a failed XHR.
 */
import { useGetMe } from "@workspace/api-client-react";

/** Default admin tier — full admin access. */
export const ADMIN_ROLES = ["super_admin", "agency_admin"] as const;

/** Extended admin tier including compliance-only views. */
export const ADMIN_OR_COMPLIANCE_ROLES = [
  "super_admin",
  "agency_admin",
  "compliance_manager",
] as const;

export function useIsAdmin(roles: readonly string[] = ADMIN_ROLES): {
  isAdmin: boolean;
  isLoading: boolean;
  role: string | null;
} {
  const { data: me, isLoading } = useGetMe();
  return {
    isAdmin: !!me && roles.includes(me.role),
    isLoading,
    role: me?.role ?? null,
  };
}
