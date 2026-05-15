// Smoke test — light, CI-able sanity pass over the hot paths.
//
// Purpose: catch gross regressions (broken endpoint, auth failure, latency
// blowout) quickly and cheaply. It runs ONE virtual user per scenario for a
// handful of iterations — enough to confirm each path is alive and within
// threshold, not a real load test (see stress.js for that).
//
// Run:  k6 run -e BASE_URL=http://localhost:3000 -e API_TOKEN=<jwt> load-tests/smoke.js
//
// Read-only by default. The write scenarios (contact create, bulk) are GATED
// behind ALLOW_WRITES=true so a CI smoke run cannot mutate data unless
// explicitly opted in:
//   k6 run -e ALLOW_WRITES=true ... load-tests/smoke.js
//
// The Twilio webhook scenario is included automatically when
// TWILIO_AUTH_TOKEN is provided.

import { THRESHOLDS, mergeThresholds, AGENT_ID } from './lib/config.js';
import { requireToken } from './lib/auth.js';

import runContactsList from './scenarios/contacts-list.js';
import runContactDetail, { setup as detailSetup } from './scenarios/contact-detail.js';
import runContactsBulk, { setup as bulkSetup } from './scenarios/contacts-bulk.js';
import runContactCreate from './scenarios/contact-create.js';
import runCommissions from './scenarios/commissions.js';
import runTwilioWebhook from './scenarios/twilio-webhook.js';

const ALLOW_WRITES = (__ENV.ALLOW_WRITES || '').toLowerCase() === 'true';
const RUN_WEBHOOK = !!__ENV.TWILIO_AUTH_TOKEN;
const RUN_COMMISSIONS = !!AGENT_ID;

// Each scenario is a short, single-VU shared-iterations burst.
function quick(exec) {
  return {
    executor: 'shared-iterations',
    vus: 1,
    iterations: 5,
    maxDuration: '1m',
    exec,
  };
}

const scenarios = {
  contactsList: quick('smokeContactsList'),
  contactDetail: quick('smokeContactDetail'),
};
if (RUN_COMMISSIONS) {
  scenarios.commissions = quick('smokeCommissions');
}
if (ALLOW_WRITES) {
  scenarios.contactsBulk = quick('smokeContactsBulk');
  scenarios.contactCreate = quick('smokeContactCreate');
}
if (RUN_WEBHOOK) {
  scenarios.twilioWebhook = quick('smokeTwilioWebhook');
}

export const options = {
  scenarios,
  thresholds: mergeThresholds(
    THRESHOLDS.read,
    THRESHOLDS.write,
    THRESHOLDS.webhook,
    THRESHOLDS.errorRate,
  ),
};

// Combined setup: validate the token once and pre-resolve ids the
// per-scenario default functions need.
export function setup() {
  requireToken();
  const data = { detail: detailSetup() };
  if (ALLOW_WRITES) {
    data.bulk = bulkSetup();
  }
  return data;
}

// Named exec functions — k6 invokes the function named by each scenario's
// `exec`. Each delegates to the corresponding scenario default function.
export function smokeContactsList() {
  runContactsList();
}
export function smokeContactDetail(data) {
  runContactDetail(data.detail);
}
export function smokeContactsBulk(data) {
  runContactsBulk(data.bulk);
}
export function smokeContactCreate() {
  runContactCreate();
}
export function smokeCommissions() {
  runCommissions();
}
export function smokeTwilioWebhook() {
  runTwilioWebhook();
}
