// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installViewAsFetch } from "../installViewAsFetch";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
  localStorage.clear();
  sessionStorage.clear();
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
  await fetch("/mediflow/api/contacts", { method: "PATCH" });

  expect(new Headers(transport.mock.calls[0][1].headers).get("X-MediFlow-View-Org")).toBe("org-b");
  expect(new Headers(transport.mock.calls[0][1].headers).get("Content-Type")).toBe("application/json");
  expect(new Headers(transport.mock.calls[1][1].headers).get("X-MediFlow-View-Org")).toBe("org-b");
  expect(transport.mock.calls[2][1]).toBeUndefined();
  expect(new Headers(transport.mock.calls[3][1].headers).get("X-MediFlow-View-Org")).toBe("org-b");
});
it("adds the stated reason only to permitted profile patches", async () => {
  const transport = vi.fn().mockResolvedValue({ status: 204 });
  globalThis.fetch = transport;
  localStorage.setItem("mediflow:view-as-org", "org-b");
  sessionStorage.setItem("mediflow:support-edit-reason", "Agency requested contact correction");
  installViewAsFetch();

  await fetch("/mediflow/api/contacts/contact-b", { method: "PATCH" });
  await fetch("/api/contacts/contact-b", { method: "DELETE" });
  await fetch("/api/contacts/contact-b/send-sms", { method: "POST" });

  expect(new Headers(transport.mock.calls[0][1].headers).get("X-MediFlow-Support-Reason")).toBe("Agency requested contact correction");
  expect(new Headers(transport.mock.calls[0][1].headers).get("X-MediFlow-Support-Edit")).toBe("true");
  expect(new Headers(transport.mock.calls[1][1].headers).has("X-MediFlow-Support-Edit")).toBe(false);
  expect(new Headers(transport.mock.calls[2][1].headers).has("X-MediFlow-Support-Edit")).toBe(false);
});
