/**
 * Minimal GoHighLevel (LeadConnector) API v2 client — contacts search and
 * custom-field definitions.
 *
 * Auth: a sub-account **Private Integration** token, sent as a Bearer token
 * with the mandatory `Version: 2021-07-28` header (GHL OpenAPI spec,
 * apps/contacts.json). Scopes: `contacts.readonly`, and
 * `locations/customFields.readonly` for the field list.
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

/** Where a request came from, for log lines and the admin-facing error message. */
type RequestLabel = "contacts search" | "custom fields";

/**
 * One GHL API call with the shared retry policy: network errors and 429/5xx
 * are retried with backoff (honouring a short `Retry-After`); a long
 * cooldown ends the run instead of blocking the worker. Returns the OK
 * response; any other status throws a `GhlApiError` that never includes the
 * upstream body (a proxy or error page could echo the Authorization header).
 */
async function ghlRequest(
  label: RequestLabel,
  path: string,
  token: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  scopeHint: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${GHL_API_BASE}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: GHL_API_VERSION,
          Accept: "application/json",
          ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Network failure or our own timeout (TLS reset, DNS blip, AbortError):
      // retry like a 5xx rather than abandoning the run.
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 1000 * 2 ** attempt;
        logger.warn({ attempt, waitMs, error: err instanceof Error ? err.name : "unknown" }, `GHL ${label}: network error, retrying`);
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
      // A Retry-After in the past (clock skew) must not mean "no wait at all".
      const waitMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 1000 * 2 ** attempt;
      logger.warn({ status: res.status, attempt, waitMs }, `GHL ${label}: retrying`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      // The upstream body is deliberately NOT included: this message is stored
      // and shown to admins, and a proxy or error page could echo the request
      // (including the Authorization header) back to us.
      await res.body?.cancel().catch(() => undefined);
      const hint = res.status === 401 || res.status === 403
        ? ` — check the Private Integration token and that it has the ${scopeHint} scope for this location`
        : res.status === 422 || res.status === 400
          ? ` — GHL rejected the ${label} request; the request format may need updating`
          : "";
      throw new GhlApiError(`GHL ${label} failed: HTTP ${res.status}${hint}`, res.status);
    }
    return res;
  }
}

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

  const res = await ghlRequest("contacts search", "/contacts/search", params.token, { method: "POST", body }, "contacts.readonly", fetchImpl);
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

/** A custom field's definition — name and type only, never a contact's value. */
export interface GhlCustomField {
  id: string;
  name: string;
  /** Merge key, e.g. `contact.medicare_number`. */
  fieldKey: string | null;
  dataType: string | null;
}

/**
 * The contact custom fields defined in a sub-account
 * (`GET /locations/:locationId/customFields?model=contact`, scope
 * `locations/customFields.readonly`). Definitions only: this call never
 * returns a contact's data, so it is safe to show to an admin mapping fields.
 */
export async function listContactCustomFields(
  params: { token: string; locationId: string },
  fetchImpl: FetchLike = fetch,
): Promise<GhlCustomField[]> {
  const path = `/locations/${encodeURIComponent(params.locationId)}/customFields?model=contact`;
  const res = await ghlRequest("custom fields", path, params.token, { method: "GET" }, "locations/customFields.readonly", fetchImpl);
  const json = (await res.json()) as { customFields?: Array<Record<string, unknown>> };
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return (Array.isArray(json.customFields) ? json.customFields : [])
    .filter((f) => str(f.id) && str(f.name) && (f.model === undefined || f.model === "contact"))
    .map((f) => ({ id: str(f.id)!, name: str(f.name)!, fieldKey: str(f.fieldKey), dataType: str(f.dataType) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
