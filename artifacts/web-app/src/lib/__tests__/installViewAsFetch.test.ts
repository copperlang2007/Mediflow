// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installViewAsFetch } from "../installViewAsFetch";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
  localStorage.clear();
  vi.restoreAllMocks();
});

it("tags direct API mutations and reads with the selected agency, but leaves identity requests alone", async () => {
  const transport = vi.fn().mockResolvedValue({ status: 204 });
  globalThis.fetch = transport;
  localStorage.setItem("mediflow:view-as-org", "org-b");
  installViewAsFetch();

  await fetch("/api/contacts", { method: "POST", headers: { "Content-Type": "application/json" } });
  await fetch("/api/contacts");
  await fetch("/api/users/me");

  expect(new Headers(transport.mock.calls[0][1].headers).get("X-MediFlow-View-Org")).toBe("org-b");
  expect(new Headers(transport.mock.calls[0][1].headers).get("Content-Type")).toBe("application/json");
  expect(new Headers(transport.mock.calls[1][1].headers).get("X-MediFlow-View-Org")).toBe("org-b");
  expect(transport.mock.calls[2][1]).toBeUndefined();
});