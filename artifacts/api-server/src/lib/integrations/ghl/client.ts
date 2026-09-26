/**
 * Minimal GoHighLevel (LeadConnector) API v2 client — contacts search only.
 *
 * Auth: a sub-account **Private Integration** token, sent as a Bearer token
 * with the mandatory `Version: 2021-07-28` header (GHL OpenAPI spec,
 * apps/contacts.json). Scope needed: `contacts.readonly`.
 *
 * Endpoint: `POST /contacts/search` — the documented replacement for the
 * deprecated `GET /contacts/`, and the only one that can filter on
 * `dateUpdated`, which is what makes an incremental pull possible. Pages are
 * requested sorted by `dateUpdated` ascending; paging continues with the
 * `searchAfter` tuple GHL returns on each contact (falling back to `page`
 * numbers if a response omits it).
 *
 * The token is never logged or included in thrown errors.
 */
import { logger } from "../../logger";

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
export const GHL_PAGE_LIMIT = 100;

export interface GhlContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  source?: string | null;
  tags?: string[] | null;
  dnd?: boolean | null;
  dateAdded?: string | null;
  dateUpdated?: string | null;
  searchAfter?: (string | number)[] | null;
}

export interface SearchPage {
  contacts: GhlContact[];
  total: number | null;
  /** Cursor for the next page: response-level if GHL sends one, else the last contact's. */
  searchAfter: (string | number)[] | null;
}

export class GhlApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GhlApiError";
  }
}

export interface SearchParams {
  token: string;
  locationId: string;
  /** Only contacts updated at or after this instant. */
  updatedSince: Date | null;
  searchAfter?: (string | number)[] | null;
  page?: number;
  pageLimit?: number;
}

type FetchLike = typeof fetch;

const MAX_ATTEMPTS = 4;

/** `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Server-requested waits this long or longer end the run instead of blocking the worker. */
const MAX_HONORED_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, MAX_HONORED_RETRY_AFTER_MS)));

export async function searchContacts(params: SearchParams, fetchImpl: FetchLike = fetch): Promise<SearchPage> {
  const body: Record<string, unknown> = {
    locationId: params.locationId,
    pageLimit: params.pageLimit ?? GHL_PAGE_LIMIT,
    sort: [{ field: "dateUpdated", direction: "asc" }],
  };
  if (params.updatedSince) {
    body.filters = [{ field: "dateUpdated", operator: "range", value: { gte: params.updatedSince.toISOString() } }];
  }
  if (params.searchAfter?.length) body.searchAfter = params.searchAfter;
  else body.page = params.page ?? 1;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${GHL_API_BASE}/contacts/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.token}`,
          Version: GHL_API_VERSION,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Network failure or our own timeout (TLS reset, DNS blip, AbortError):
      // retry like a 5xx rather than abandoning the run.
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 1000 * 2 ** attempt;
        logger.warn({ attempt, waitMs, error: err instanceof Error ? err.name : "unknown" }, "GHL search: network error, retrying");
        await sleep(waitMs);
        continue;
      }
      throw err;
    }

    // Rate limit (GHL: burst 100 req / 10 s per location) or transient 5xx.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (retryAfterMs !== null && retryAfterMs >= MAX_HONORED_RETRY_AFTER_MS) {
        // A long cooldown (e.g. the daily quota): retrying sooner just burns
        // attempts and can extend the ban. End this run; the next scheduled
        // run resumes from the saved cursor.
        await res.body?.cancel().catch(() => undefined);
        throw new GhlApiError(
          `GHL rate limit: HTTP ${res.status}, retry after ${Math.ceil(retryAfterMs / 1000)}s — the next scheduled sync will resume where this one stopped`,
          res.status,
        );
      }
      const waitMs = retryAfterMs ?? 1000 * 2 ** attempt;
      logger.warn({ status: res.status, attempt, waitMs }, "GHL search: retrying");
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      // The upstream body is deliberately NOT included: this message is stored
      // and shown to admins, and a proxy or error page could echo the request
      // (including the Authorization header) back to us.
      await res.body?.cancel().catch(() => undefined);
      const hint = res.status === 401 || res.status === 403
        ? " — check the Private Integration token and that it has the contacts.readonly scope for this location"
        : res.status === 422 || res.status === 400
          ? " — GHL rejected the search request; the request format may need updating"
          : "";
      throw new GhlApiError(`GHL contacts search failed: HTTP ${res.status}${hint}`, res.status);
    }

    const json = (await res.json()) as { contacts?: GhlContact[]; total?: number; count?: number; searchAfter?: (string | number)[] };
    const contacts = Array.isArray(json.contacts) ? json.contacts : [];
    const last = contacts[contacts.length - 1];
    return {
      contacts,
      total: typeof json.total === "number" ? json.total : typeof json.count === "number" ? json.count : null,
      searchAfter: Array.isArray(json.searchAfter) && json.searchAfter.length
        ? json.searchAfter
        : last?.searchAfter?.length ? last.searchAfter : null,
    };
  }
}
