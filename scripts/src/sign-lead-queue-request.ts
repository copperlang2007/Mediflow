/**
 * Reference signer + smoke-test for the public inbound-lead-queue endpoint
 * (`POST /api/queue/v1/route-inbound`) — the entry point the GoHighLevel /
 * Atlas proxy calls.
 *
 * Why this exists: the proxy and MediFlow must compute the SAME HMAC over the
 * SAME bytes, or every request is rejected. This script is the canonical
 * oracle for that contract. It mirrors the server's verifier exactly
 * (artifacts/api-server/src/lib/dialer/signature.ts):
 *
 *     X-MB-Signature: t=<unixSeconds>,v1=<hex HMAC-SHA256 over `${t}.${rawBody}`>
 *
 * Two ways to use it:
 *
 *  1. PARITY — confirm the Atlas proxy signs identically. Run with a fixed
 *     `--t` and the exact body the proxy sends; compare the printed `v1` to the
 *     proxy's. If they differ, the proxy is signing different bytes (usually a
 *     re-serialized body or a different base string).
 *
 *  2. SMOKE — prove the live endpoint accepts a correctly-signed request. Add
 *     `--send --url https://<host>/api/queue/v1/route-inbound`; the script
 *     POSTs the exact signed bytes and prints the status + response (incl. the
 *     flat `target_phone` / `target_user_id` GHL consumes).
 *
 * Secret resolution mirrors the server: `--secret`, else
 * `LEAD_QUEUE_WEBHOOK_SECRET_<ORGID>` (orgId upper-cased, non-alphanumerics →
 * `_`), else `LEAD_QUEUE_WEBHOOK_SECRET`. Fail-closed: no secret → no run.
 *
 * Examples:
 *   # Build a body from flags, print the signed request (no network):
 *   pnpm --filter @workspace/scripts lq:sign -- \
 *     --secret s3cr3t --org org_123 --carrier-name "Acme Health" --state FL
 *
 *   # Sign the EXACT bytes the proxy sends, with a fixed timestamp, to diff v1:
 *   pnpm --filter @workspace/scripts lq:sign -- \
 *     --secret s3cr3t --org org_123 --t 1780000000 \
 *     --body '{"orgId":"org_123","carrierName":"Acme Health","contactState":"FL"}'
 *
 *   # Smoke-test the live endpoint:
 *   pnpm --filter @workspace/scripts lq:sign -- \
 *     --org org_123 --carrier-name "Acme Health" --state FL \
 *     --url https://api.example.com/api/queue/v1/route-inbound --send
 *
 * Exits 0 on success (or a routed/no_agent_available response); 1 on a usage
 * error, a missing secret, or a non-2xx response when `--send` is used.
 */
import { createHmac } from "node:crypto";

interface Args {
  [key: string]: string | boolean | undefined;
}

/** Minimal `--flag value` / `--bool` parser. */
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Mirror of the server's per-tenant secret resolution. */
function resolveSecret(orgId: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const perTenant =
    process.env[
      `LEAD_QUEUE_WEBHOOK_SECRET_${orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
    ]?.trim();
  if (perTenant) return perTenant;
  return process.env.LEAD_QUEUE_WEBHOOK_SECRET?.trim() || undefined;
}

/** The canonical signature — byte-identical to lib/dialer/signature.ts. */
function computeSignature(secret: string, t: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
}

function boolish(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true) return true;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const orgId = str(args.org) ?? str(args.orgId);
  if (!orgId) fail("--org <orgId> is required");

  // Body: either an exact raw JSON string (best for parity), or built from
  // flags. When built, we serialize once and sign/send those exact bytes.
  let rawBody = str(args.body);
  if (!rawBody) {
    const body: Record<string, unknown> = { orgId };
    const carrierId = str(args.carrier) ?? str(args.carrierId);
    const carrierName = str(args["carrier-name"]) ?? str(args.carrierName);
    if (carrierId) body.carrierId = carrierId;
    if (carrierName) body.carrierName = carrierName;
    if (!carrierId && !carrierName)
      fail("provide --carrier <id> or --carrier-name <name> (or pass --body)");
    const state = str(args.state) ?? str(args.contactState);
    const contactId = str(args.contact) ?? str(args.contactId);
    if (state) body.contactState = state.toUpperCase();
    if (contactId) body.contactId = contactId;
    if (!state && !contactId)
      fail("provide --state <XX> or --contact <contactId> (or pass --body)");
    const certYear = str(args["cert-year"]) ?? str(args.certificationYear);
    if (certYear) body.certificationYear = Number(certYear);
    const requireAhip = boolish(args["require-ahip"] ?? args.requireAhip);
    if (requireAhip !== undefined) body.requireAhip = requireAhip;
    const availableOnly = boolish(args["available-only"] ?? args.availableOnly);
    if (availableOnly !== undefined) body.availableOnly = availableOnly;
    rawBody = JSON.stringify(body);
  }

  const secret = resolveSecret(orgId, str(args.secret));
  if (!secret)
    fail(
      "no signing secret — pass --secret or set LEAD_QUEUE_WEBHOOK_SECRET[_<ORGID>]",
    );

  const t = str(args.t) ? Number(str(args.t)) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t)) fail("--t must be a unix timestamp (seconds)");

  const v1 = computeSignature(secret, t, rawBody);
  const sigHeader = `t=${t},v1=${v1}`;

  console.log("--- signed request ---");
  console.log(`rawBody (bytes signed): ${rawBody}`);
  console.log(`t (unix seconds):       ${t}`);
  console.log(`X-MB-Signature:         ${sigHeader}`);
  console.log("");

  const url = str(args.url);
  if (url) {
    console.log("curl:");
    console.log(
      `  curl -sS -X POST '${url}' \\\n` +
        `    -H 'Content-Type: application/json' \\\n` +
        `    -H 'X-MB-Signature: ${sigHeader}' \\\n` +
        `    --data '${rawBody}'`,
    );
    console.log("");
  } else {
    console.log("(no --url given; pass --url ... [--send] to hit the endpoint)");
  }

  if (args.send) {
    if (!url) fail("--send requires --url <endpoint>");
    console.log(`POST ${url} ...`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MB-Signature": sigHeader,
      },
      body: rawBody,
    });
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    console.log(text);
    if (!res.ok) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
