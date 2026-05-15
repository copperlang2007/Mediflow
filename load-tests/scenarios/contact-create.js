// Scenario: POST /contacts — contact creation.
//
// Each create also enqueues a `run-automation-rules` pg-boss job
// (routes/contacts.ts), so this scenario indirectly exercises the enqueue
// path and the automation worker queue depth.
//
// Write path; threshold p95 < 1s.
//
// NOTE: this scenario WRITES rows. Point it at a disposable/staging org —
// never production. Created contacts are tagged `loadtest` so they can be
// cleaned up afterwards (see README).
//
// Run standalone:  k6 run -e API_TOKEN=<jwt> load-tests/scenarios/contact-create.js

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { authHeaders, requireToken } from '../lib/auth.js';
import { expectCreated } from '../lib/checks.js';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.write, THRESHOLDS.errorRate),
};

export function setup() {
  requireToken();
}

const STATES = ['CA', 'TX', 'FL', 'NY', 'AZ'];
const PLANS = ['MA', 'PDP', 'MAPD', 'supp', 'other'];

function randomContact() {
  const n = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    firstName: `Load${n.slice(-6)}`,
    lastName: `Test${n.slice(-4)}`,
    email: `loadtest+${n}@example.com`,
    phone: `+1500555${String(Math.floor(Math.random() * 9000) + 1000)}`,
    stateCode: STATES[Math.floor(Math.random() * STATES.length)],
    currentPlanType: PLANS[Math.floor(Math.random() * PLANS.length)],
    status: 'lead',
    leadSource: 'load-test',
    tags: ['loadtest'],
  };
}

export default function () {
  const res = http.post(`${API_BASE}/contacts`, JSON.stringify(randomContact()), {
    headers: authHeaders(),
    tags: { kind: 'write', endpoint: 'POST /contacts' },
  });
  expectCreated(res, 'POST /contacts');
  sleep(1);
}
