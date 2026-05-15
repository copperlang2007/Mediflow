// Scenario: POST /contacts/bulk — bulk tag / status / assignment operations.
//
// The bulk endpoint accepts up to 200 ids and applies a set-based UPDATE.
// This scenario first discovers a pool of contact ids, then repeatedly fires
// bulk add_tag / remove_tag / set_status operations against random subsets.
//
// Write path; threshold p95 < 1s.
//
// NOTE: this scenario MUTATES contact rows (tags + status). Run against a
// disposable/staging org only.
//
// Run standalone:  k6 run -e API_TOKEN=<jwt> load-tests/scenarios/contacts-bulk.js

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { authHeaders, requireToken } from '../lib/auth.js';
import { expectOk } from '../lib/checks.js';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.write, THRESHOLDS.errorRate),
};

// Discover a pool of contact ids to operate on. The bulk endpoint verifies
// every id belongs to the caller's org, so the pool must be real ids.
export function setup() {
  requireToken();
  const res = http.get(`${API_BASE}/contacts?limit=200`, { headers: authHeaders() });
  if (res.status !== 200) {
    throw new Error(`setup: could not list contacts (status ${res.status})`);
  }
  const body = res.json();
  const ids = (body && body.data ? body.data : []).map((c) => c.id);
  if (ids.length === 0) {
    throw new Error('setup: target org has no contacts — seed data first');
  }
  return { ids };
}

function sample(ids, n) {
  const pool = ids.slice();
  const out = [];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

export default function (data) {
  // Random subset size up to the endpoint's 200-id cap.
  const subset = sample(data.ids, Math.floor(Math.random() * 100) + 20);
  const actions = [
    { action: 'add_tag', payload: { tag: 'loadtest-bulk' } },
    { action: 'remove_tag', payload: { tag: 'loadtest-bulk' } },
    { action: 'set_status', payload: { status: 'prospect' } },
  ];
  const pick = actions[Math.floor(Math.random() * actions.length)];

  const res = http.post(
    `${API_BASE}/contacts/bulk`,
    JSON.stringify({ ids: subset, action: pick.action, payload: pick.payload }),
    {
      headers: authHeaders(),
      tags: { kind: 'write', endpoint: 'POST /contacts/bulk' },
    },
  );
  expectOk(res, `POST /contacts/bulk ${pick.action}`);
  sleep(1);
}
