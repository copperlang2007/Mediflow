// Scenario: commission statement upload + parse + reconcile.
//
// The HTTP flow (routes/commissions.ts) is three steps:
//   1. POST /commissions/statements             (multipart: file + metadata)
//   2. POST /commissions/statements/:id/parse   (multipart: same file again —
//      blob storage is not wired up, so the parser re-reads the upload)
//   3. POST /commissions/statements/:id/reconcile?async=true
//      (enqueues the reconcile worker rather than running it inline; the
//      inline path can be seconds-long for large statements and would blow
//      the write threshold — see SCALE-AUDIT.md)
//
// All three require MFA (`requireMfa`) and `commission:create/update`
// permission, so the supplied API_TOKEN must belong to an MFA-enrolled
// admin/super_admin. If the token lacks MFA the steps return 403 and the
// run will fail the error-rate threshold — that is the signal to use a
// properly-scoped token.
//
// Required env:
//   API_TOKEN    MFA-enrolled admin Clerk JWT.
//   CARRIER_ID   A carrier id in the target org (statement upload validates
//                the carrier belongs to the org).
//
// NOTE: this scenario WRITES statements + line items and enqueues worker
// jobs. Staging/disposable orgs only. It runs at low concurrency because
// each iteration is a heavy multi-step write.
//
// Run standalone:
//   k6 run -e API_TOKEN=<jwt> -e CARRIER_ID=<id> load-tests/scenarios/commission-upload.js

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, API_TOKEN, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { requireToken } from '../lib/auth.js';
import { expectOk } from '../lib/checks.js';
import { check } from 'k6';

export const options = {
  // Heavy multi-step write — keep concurrency low.
  vus: 2,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.write, THRESHOLDS.errorRate),
};

const CARRIER_ID = __ENV.CARRIER_ID || '';

export function setup() {
  requireToken();
  if (!CARRIER_ID) {
    throw new Error(
      'CARRIER_ID is not set. Statement upload validates the carrier id ' +
        'against the org; pass `-e CARRIER_ID=<id>`.',
    );
  }
}

// Multipart requests can't carry an Authorization header set by http.file's
// auto content-type, so headers are built per request.
function multipartHeaders() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    Cookie: `__session=${API_TOKEN}`,
  };
}

// Build a small synthetic statement CSV. The exact columns the parser
// expects are carrier-specific; this generic shape is enough to exercise
// the upload + reconcile-enqueue latency. Real-carrier CSVs can be dropped
// into load-tests/fixtures/ and read with open() if precise parsing is
// needed.
function syntheticCsv(rows) {
  const lines = ['member_id,policy_number,plan_type,premium,commission_amount'];
  for (let i = 0; i < rows; i++) {
    lines.push(`MBI${1000 + i},POL${2000 + i},MA,120.00,18.00`);
  }
  return lines.join('\n');
}

export default function () {
  const csv = syntheticCsv(50);
  const today = new Date().toISOString().slice(0, 10);

  // Step 1: upload statement metadata + file.
  const uploadRes = http.post(
    `${API_BASE}/commissions/statements`,
    {
      file: http.file(csv, 'loadtest-statement.csv', 'text/csv'),
      carrierId: CARRIER_ID,
      statementDate: today,
      periodStart: today,
      periodEnd: today,
    },
    {
      headers: multipartHeaders(),
      tags: { kind: 'write', endpoint: 'POST /commissions/statements' },
    },
  );
  const uploaded = expectOk(uploadRes, 'POST /commissions/statements', true);
  if (!uploaded || !uploaded.id) {
    sleep(1);
    return;
  }

  // Step 2: parse — re-upload the same file.
  const parseRes = http.post(
    `${API_BASE}/commissions/statements/${uploaded.id}/parse`,
    { file: http.file(csv, 'loadtest-statement.csv', 'text/csv') },
    {
      headers: multipartHeaders(),
      tags: { kind: 'write', endpoint: 'POST /commissions/statements/:id/parse' },
    },
  );
  // Parse may legitimately 400 if the synthetic CSV does not match the
  // carrier parser — accept 2xx or 400 here but flag 5xx.
  check(parseRes, {
    'parse: not a server error': (r) => r.status < 500,
  });

  // Step 3: reconcile — async so the worker does the heavy lifting.
  const reconcileRes = http.post(
    `${API_BASE}/commissions/statements/${uploaded.id}/reconcile?async=true`,
    null,
    {
      headers: { Authorization: `Bearer ${API_TOKEN}`, Cookie: `__session=${API_TOKEN}` },
      tags: { kind: 'write', endpoint: 'POST /commissions/statements/:id/reconcile' },
    },
  );
  expectOk(reconcileRes, 'POST /commissions/statements/:id/reconcile');

  sleep(2);
}
