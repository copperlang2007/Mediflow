// Scenario: GET /agents/:id/commissions — per-agent commission reporting.
//
// This is a heavy query: it fans out into a paginated line-items scan plus a
// full payouts scan, optionally narrowed by period and type
// (routes/commissions.ts). It is a read path but heavier than a list screen,
// so it is treated under the read threshold (p95 < 500ms) to surface
// regressions early.
//
// Required env:
//   AGENT_ID   An agent id in the target org. The script aborts if unset
//              because there is no safe way to discover one without the
//              agents list permission, which the load token may not have.
//
// Run standalone:
//   k6 run -e API_TOKEN=<jwt> -e AGENT_ID=<id> load-tests/scenarios/commissions.js

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, AGENT_ID, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { authHeaders, requireToken } from '../lib/auth.js';
import { expectOk } from '../lib/checks.js';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.read, THRESHOLDS.errorRate),
};

export function setup() {
  requireToken();
  if (!AGENT_ID) {
    throw new Error(
      'AGENT_ID is not set. The commissions scenario needs a real agent id; ' +
        'pass `-e AGENT_ID=<id>`.',
    );
  }
}

// Recent months to query the `period=YYYY-MM` filter with, plus an
// unfiltered (all-time) variant which is the heaviest case.
function recentPeriods() {
  const out = [''];
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const PERIODS = recentPeriods();

export default function () {
  const period = PERIODS[Math.floor(Math.random() * PERIODS.length)];
  const qs = period ? `?period=${period}&limit=100` : '?limit=100';
  const res = http.get(`${API_BASE}/agents/${AGENT_ID}/commissions${qs}`, {
    headers: authHeaders(),
    tags: { kind: 'read', endpoint: 'GET /agents/:id/commissions' },
  });
  expectOk(res, 'GET /agents/:id/commissions');
  sleep(1);
}
