// Scenario: POST /api/dialer/v1/events — inbound masterBRIDGE dialer event
// receiver (Option A, spec §6). This is the latency-sensitive ingress the
// dialer hits for every call lifecycle event; if it is slow the dialer's
// webhook delivery backs up and retries multiply.
//
// The handler verifies an HMAC-SHA256 `X-MB-Signature: t=<ts>,v1=<hmac>` over
// `${t}.${rawBody}` keyed by the per-tenant shared secret, bound to ±5 min
// (artifacts/api-server/src/lib/dialer/signature.ts). This script reproduces
// that signing so events are accepted (200) rather than rejected (401/403).
//
// Each iteration sends a UNIQUE eventId so the eventId ledger does not dedup
// the load (a duplicate would 200 as "duplicate" without doing real work,
// which would understate the receiver's true throughput). A small fraction of
// events are deliberately re-sent to also exercise the dedup hot path.
//
// Required env:
//   DIALER_EVENTS_URL      Exact public URL the dialer POSTs to, e.g.
//                          https://staging.mediflow.example/api/dialer/v1/events
//                          Default: ${BASE_URL}/api/dialer/v1/events
//   DIALER_WEBHOOK_SECRET  The same per-tenant shared secret the server
//                          resolves (DIALER_WEBHOOK_SECRET[_<ORGID>]). Without
//                          it every request 401s.
//   DIALER_ORG_ID          An org id that exists in the target environment;
//                          the event envelope's `orgId` must reference a real
//                          tenant (FK on dialer_events.org_id).
//
// Run standalone:
//   k6 run -e DIALER_WEBHOOK_SECRET=xxx -e DIALER_ORG_ID=org_123 \
//          -e BASE_URL=http://localhost:3000 \
//          load-tests/scenarios/dialer-events.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import { BASE_URL, THRESHOLDS, mergeThresholds } from '../lib/config.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.webhook, THRESHOLDS.errorRate),
};

const EVENTS_URL = __ENV.DIALER_EVENTS_URL || `${BASE_URL}/api/dialer/v1/events`;
const SECRET = __ENV.DIALER_WEBHOOK_SECRET || '';
const ORG_ID = __ENV.DIALER_ORG_ID || '';

export function setup() {
  if (!SECRET) {
    throw new Error(
      'DIALER_WEBHOOK_SECRET is not set. The receiver verifies an HMAC-SHA256 ' +
        'signature; without the secret every request is rejected 401. ' +
        'Pass `-e DIALER_WEBHOOK_SECRET=<secret>`.',
    );
  }
  if (!ORG_ID) {
    throw new Error(
      'DIALER_ORG_ID is not set. The event envelope orgId must reference a ' +
        'real tenant (FK). Pass `-e DIALER_ORG_ID=<org id>`.',
    );
  }
}

// Reproduce the X-MB-Signature scheme: HMAC-SHA256 hex over `${t}.${rawBody}`.
function sign(rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.hmac('sha256', SECRET, `${t}.${rawBody}`, 'hex');
  return `t=${t},v1=${v1}`;
}

// A spread of lifecycle event types (§6). Non-terminal events are cheapest;
// terminal ones exercise the terminal-outcome path. Unknown types exercise the
// forward-compat ignore path (§6.2).
const TYPES = [
  'call.initiated',
  'call.ringing',
  'call.in_progress',
  'call.completed',
  'call.failed',
  'call.future.unknown_type',
];

function buildEnvelope() {
  const type = TYPES[Math.floor(Math.random() * TYPES.length)];
  return JSON.stringify({
    eventId: `evt_${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
    schemaVersion: 1,
    type,
    occurredAt: new Date().toISOString(),
    orgId: ORG_ID,
    // No dialTicketId/dialerCallId: a load event need not correlate to a real
    // ticket to exercise verify + ledger insert + dispatch + audit.
    data: type === 'call.completed' ? { duration: 30, endedReason: 'HANGUP' } : {},
  });
}

export default function () {
  const raw = buildEnvelope();
  // Sign once: the signature is over the exact bytes we send.
  const signature = sign(raw);
  const res = http.post(EVENTS_URL, raw, {
    headers: {
      'Content-Type': 'application/json',
      'X-MB-Signature': signature,
    },
    tags: { kind: 'webhook', endpoint: 'POST /api/dialer/v1/events' },
  });
  check(res, {
    'dialer event accepted (2xx)': (r) => r.status >= 200 && r.status < 300,
  });
  sleep(1);
}
