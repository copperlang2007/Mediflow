// @vitest-environment jsdom
/**
 * Tests for the shared `useIsAdmin` hook.
 *
 * The hook is a thin wrapper over `useGetMe` — we seed the query cache with a
 * fake user (or leave it pending) and assert the role-check semantics. We
 * exercise both the default `ADMIN_ROLES` tier and the
 * `ADMIN_OR_COMPLIANCE_ROLES` extended tier to lock in the contract every
 * admin-gated page now depends on.
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import {
  useIsAdmin,
  ADMIN_ROLES,
  ADMIN_OR_COMPLIANCE_ROLES,
} from "@/lib/auth/useIsAdmin";

type Me = {
  id: string;
  orgId: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
};

function makeUser(role: string): Me {
  return {
    id: "u-1",
    orgId: "o-1",
    email: "u@example.com",
    fullName: "User",
    role,
    isActive: true,
  };
}

function makeClient(user: Me | null): QueryClient {
  // retry: false keeps a loading state from re-fetching the (non-existent)
  // /me endpoint when no user is seeded — we want a clean "still loading"
  // observation, not an error.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (user) qc.setQueryData(getGetMeQueryKey(), user);
  return qc;
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useIsAdmin", () => {
  it("returns isAdmin: true for a super_admin user", () => {
    const qc = makeClient(makeUser("super_admin"));
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(qc) });
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.role).toBe("super_admin");
    expect(result.current.isLoading).toBe(false);
  });

  it("returns isAdmin: true for an agency_admin user", () => {
    const qc = makeClient(makeUser("agency_admin"));
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(qc) });
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.role).toBe("agency_admin");
  });

  it("returns isAdmin: false for a role outside the default tier", () => {
    const qc = makeClient(makeUser("agent"));
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(qc) });
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe("agent");
  });

  it("excludes compliance_manager from the default ADMIN_ROLES tier", () => {
    // This is the key semantic-preservation guarantee: pages that historically
    // accepted only super_admin/agency_admin must keep rejecting
    // compliance_manager, even though the extended tier accepts them.
    const qc = makeClient(makeUser("compliance_manager"));
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(qc) });
    expect(result.current.isAdmin).toBe(false);
  });

  it("accepts compliance_manager when ADMIN_OR_COMPLIANCE_ROLES is passed", () => {
    const qc = makeClient(makeUser("compliance_manager"));
    const { result } = renderHook(
      () => useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES),
      { wrapper: wrap(qc) },
    );
    expect(result.current.isAdmin).toBe(true);
  });

  it("still rejects an unrelated role even with the extended tier", () => {
    const qc = makeClient(makeUser("agent"));
    const { result } = renderHook(
      () => useIsAdmin(ADMIN_OR_COMPLIANCE_ROLES),
      { wrapper: wrap(qc) },
    );
    expect(result.current.isAdmin).toBe(false);
  });

  it("reports isLoading: true and role: null while useGetMe is loading", () => {
    // No data seeded + retry off means the query stays in `isLoading: true`
    // without firing a real network request.
    const qc = makeClient(null);
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(qc) });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBeNull();
  });

  it("exposes the canonical ADMIN_ROLES constant", () => {
    // Locking the constant in a test guards against accidental edits — every
    // admin page passes this (or extends it) and a silent rename here would
    // silently broaden or narrow page access.
    expect(ADMIN_ROLES).toEqual(["super_admin", "agency_admin"]);
    expect(ADMIN_OR_COMPLIANCE_ROLES).toEqual([
      "super_admin",
      "agency_admin",
      "compliance_manager",
    ]);
  });
});
