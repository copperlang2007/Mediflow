/** Cover direct fetch calls as well as the generated API client during agency viewing. */
export function installViewAsFetch(): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let orgId: string | null = null;
    try { orgId = globalThis.localStorage?.getItem("mediflow:view-as-org") ?? null; } catch { /* storage unavailable */ }
    if (!orgId) return originalFetch(input, init);

    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, globalThis.location.href);
    if (url.origin !== globalThis.location.origin || !url.pathname.includes("/api/") || url.pathname.endsWith("/api/users/me")) {
      return originalFetch(input, init);
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("X-MediFlow-View-Org", orgId);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const supportPath = /\/api\/(contacts|agents)\/[^/]+$/.test(url.pathname);
    if (method === "PATCH" && supportPath) {
      let reason: string | null = null;
      try { reason = globalThis.sessionStorage?.getItem("mediflow:support-edit-reason") ?? null; } catch { /* storage unavailable */ }
      if (reason) {
        headers.set("X-MediFlow-Support-Edit", "true");
        headers.set("X-MediFlow-Support-Reason", reason);
      }
    }
    return originalFetch(input, { ...init, headers });
  };
}