// Stress test — ramp load up until thresholds break, to find the knee.
//
// Purpose: deliberately push the API past its comfort zone to discover the
// breaking point — the concurrency at which p95 latency or error rate
// crosses the SLO. Unlike smoke.js this is NOT meant to pass cleanly; a
// threshold breach here is the *result* you are looking for. k6 still exits
// non-zero on breach, so run it manually, not in a blocking CI gate.
//
// Default mix: read-heavy (contacts list + detail + commissions), which is
// representative of real CRM traffic. Write scenarios are opt-in via
// ALLOW_WRITES=true and the Twilio webhook is included when
// TWILIO_AUTH_TOKEN is set.
//
// The ramp: warm up -> climb -> sustain peak -> cool down. Adjust PEAK_VUS
// to push harder:
//   k6 run -e PEAK_VUS=300 -e API_TOKEN=<jwt> load-tests/stress.js
//
// Run:  k6 run -e BASE_URL=https://staging... -e API_TOKEN=<jwt> load-tests/stress.js

import { THRESHOLDS, mergeThresholds, AGENT_ID } from './lib/config.js';
import { requireToken } from './lib/auth.js';

import runContactsList from './scenarios/contacts-list.js';
import runContactDetail, { setup as detailSetup } from './scenarios/contact-detail.js';
import runContactsBulk, { setup as bulkSetup } from './scenarios/contacts-bulk.js';
import runContactCreate from './scenarios/contact-create.js';
import runCommissions from './scenarios/commissions.js';
import runTwilioWebhook from './scenarios/twilio-webhook.js';

const PEAK_VUS = parseInt(__ENV.PEAK_VUS || '150', 10);
const ALLOW_WRITES = (__ENV.ALLOW_WRITES || '').toLowerCase() === 'true';
const RUN_WEBHOOK = !!__ENV.TWILIO_AUTH_TOKEN;
const RUN_COMMISSIONS = !!AGENT_ID;

// Ramping stages scaled relative to PEAK_VUS: warm up to 10%, climb to 50%,
// climb to 100%, hold the peak, then cool down.
function ramp(exec, peakFraction) {
  const peak = Math.max(1, Math.round(PEAK_VUS * peakFraction));
  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: Math.max(1, Math.round(peak * 0.1)) },
      { duration: '1m', target: Math.max(1, Math.round(peak * 0.5)) },
      { duration: '2m', target: peak },
      { duration: '2m', target: peak },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '20s',
    exec,
  };
}

// Read scenarios carry the bulk of the load; writes (when enabled) get a
// smaller share since they are more expensive and mutate data.
const scenarios = {
  contactsList: ramp('stressContactsList', 0.6),
  contactDetail: ramp('stressContactDetail', 0.3),
};
if (RUN_COMMISSIONS) {
  scenarios.commissions = ramp('stressCommissions', 0.1);
}
if (ALLOW_WRITES) {
  scenarios.contactCreate = ramp('stressContactCreate', 0.1);
  scenarios.contactsBulk = ramp('stressContactsBulk', 0.05);
}
if (RUN_WEBHOOK) {
  scenarios.twilioWebhook = ramp('stressTwilioWebhook', 0.2);
}

export const options = {
  scenarios,
  // Same SLO thresholds as everywhere else — a breach here is the signal
  // that the system hit its breaking point. `abortOnFail` stops the run
  // early once an SLO is clearly blown so you don't burn the full ramp.
  thresholds: mergeThresholds(
    {
      'http_req_duration{kind:read}': [
        { threshold: 'p(95)<500', abortOnFail: true, delayAbortEval: '1m' },
      ],
      'http_req_duration{kind:write}': [
        { threshold: 'p(95)<1000', abortOnFail: true, delayAbortEval: '1m' },
      ],
      'http_req_duration{kind:webhook}': [
        { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '1m' },
      ],
    },
    THRESHOLDS.errorRate,
  ),
};

export function setup() {
  requireToken();
  const data = { detail: detailSetup() };
  if (ALLOW_WRITES) {
    data.bulk = bulkSetup();
  }
  return data;
}

export function stressContactsList() {
  runContactsList();
}
export function stressContactDetail(data) {
  runContactDetail(data.detail);
}
export function stressContactsBulk(data) {
  runContactsBulk(data.bulk);
}
export function stressContactCreate() {
  runContactCreate();
}
export function stressCommissions() {
  runCommissions();
}
export function stressTwilioWebhook() {
  runTwilioWebhook();
}
