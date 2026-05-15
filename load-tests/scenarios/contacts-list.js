// Scenario: GET /contacts — the paginated contact list, the main CRM screen.
//
// Exercises the list endpoint with a realistic mix of filtering, search, and
// pagination. This is a read path; threshold is p95 < 500ms.
//
// Run standalone:  k6 run -e API_TOKEN=<jwt> load-tests/scenarios/contacts-list.js
// Or imported by smoke.js / stress.js.

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { authHeaders, requireToken } from '../lib/auth.js';
import { expectOk } from '../lib/checks.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.read, THRESHOLDS.errorRate),
};

export function setup() {
  requireToken();
}

// A spread of query shapes the list endpoint accepts, so the run touches
// the search ilike path, the status/agent filters, and deep pagination.
const QUERIES = [
  '?limit=50',
  '?limit=50&offset=50',
  '?limit=50&offset=500',
  '?status=lead&limit=50',
  '?status=enrolled&sortBy=name&sortDir=asc&limit=50',
  '?search=john&limit=25',
  '?sortBy=createdAt&sortDir=desc&limit=100',
];

export default function () {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const res = http.get(`${API_BASE}/contacts${q}`, {
    headers: authHeaders(),
    tags: { kind: 'read', endpoint: 'GET /contacts' },
  });
  expectOk(res, 'GET /contacts');
  sleep(1);
}
