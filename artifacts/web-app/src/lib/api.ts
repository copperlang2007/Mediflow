import { ensureFreshSession } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function getViewAsOrgId(): string | null {
  try { return globalThis.localStorage?.getItem("mediflow:view-as-org") ?? null; } catch { return null; }
}

function withViewAsHeader(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  const viewAsOrgId = getViewAsOrgId();
  if (viewAsOrgId && !merged.has("x-mediflow-view-org")) merged.set("x-mediflow-view-org", viewAsOrgId);
  return merged;
}
/**
 * Options accepted by `apiFetch`. Extends `RequestInit` with an explicit
 * `signal` callout — `RequestInit` already accepts a `signal`, but spelling it
 * out here makes the cancellation contract discoverable from the call site
 * (and lets us document it). When the signal aborts mid-request the returned
 * promise rejects with an `AbortError`, the standard fetch contract.
 */
export interface ApiFetchOptions extends RequestInit {
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchOptions = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const { signal, ...rest } = init;
  const fresh = ensureFreshSession();
  if (fresh) await fresh;
  const res = await fetch(url, {
    ...rest,
    credentials: "include",
    ...(signal !== undefined ? { signal } : {}),
    headers: withViewAsHeader(rest.headers),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error((body as { error?: string }).error ?? res.statusText) as Error & { status: number; data: unknown };
    err.status = res.status;
    err.data = body;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export async function apiRequest<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const fresh = ensureFreshSession();
  if (fresh) await fresh;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: (() => {
      const headers = withViewAsHeader(init.headers);
      if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
      return headers;
    })(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(body.error ?? res.statusText) as Error & {
      status: number;
      data: unknown;
    };
    err.status = res.status;
    err.data = body;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}
