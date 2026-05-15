// Scenario: GET /contacts/:id and its sub-resources.
//
// The contact-detail screen fans out into several reads: the contact record
// itself plus /threads, /messages, and /activities. This script reproduces
// that fan-out per iteration so the combined latency of opening a contact is
// measured, not just one endpoint.
//
// All reads; threshold p95 < 500ms.
//
// Run standalone:  k6 run -e API_TOKEN=<jwt> load-tests/scenarios/contact-detail.js

import http from 'k6/http';
import { sleep } from 'k6';
import { API_BASE, CONTACT_ID, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { authHeaders, requireToken } from '../lib/auth.js';
import { expectOk } from '../lib/checks.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.read, THRESHOLDS.errorRate),
};

// Resolve a contact id once. If CONTACT_ID is supplied use it; otherwise
// discover the first contact from the list endpoint so the script is
// self-contained against any seeded org.
export function setup() {
  requireToken();
  if (CONTACT_ID) return { contactId: CONTACT_ID };

  const res = http.get(`${API_BASE}/contacts?limit=1`, { headers: authHeaders() });
  if (res.status !== 200) {
    throw new Error(`setup: could not list contacts (status ${res.status})`);
  }
  const body = res.json();
  const first = body && body.data && body.data[0];
  if (!first) {
    throw new Error('setup: target org has no contacts — seed data or pass -e CONTACT_ID=');
  }
  return { contactId: first.id };
}

export default function (data) {
  const id = data.contactId;
  const headers = authHeaders();

  // The detail header read.
  const detail = http.get(`${API_BASE}/contacts/${id}`, {
    headers,
    tags: { kind: 'read', endpoint: 'GET /contacts/:id' },
  });
  expectOk(detail, 'GET /contacts/:id');

  // Sub-resources, batched the way the detail screen loads them.
  const responses = http.batch([
    {
      method: 'GET',
      url: `${API_BASE}/contacts/${id}/threads?limit=50`,
      params: { headers, tags: { kind: 'read', endpoint: 'GET /contacts/:id/threads' } },
    },
    {
      method: 'GET',
      url: `${API_BASE}/contacts/${id}/messages?limit=100`,
      params: { headers, tags: { kind: 'read', endpoint: 'GET /contacts/:id/messages' } },
    },
    {
      method: 'GET',
      url: `${API_BASE}/contacts/${id}/activities?limit=50`,
      params: { headers, tags: { kind: 'read', endpoint: 'GET /contacts/:id/activities' } },
    },
  ]);
  expectOk(responses[0], 'GET /contacts/:id/threads');
  expectOk(responses[1], 'GET /contacts/:id/messages');
  expectOk(responses[2], 'GET /contacts/:id/activities');

  sleep(1);
}
