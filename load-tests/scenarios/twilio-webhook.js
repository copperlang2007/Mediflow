// Scenario: POST /webhooks/twilio/sms — inbound Twilio SMS webhook.
//
// This is the latency-sensitive path: Twilio abandons the request and retries
// if the handler does not respond within 10s. The threshold here is a strict
// p95 < 2s to leave generous headroom.
//
// The handler validates an HMAC-SHA1 `X-Twilio-Signature` over
// `url + sorted(param key+value)` keyed by TWILIO_AUTH_TOKEN
// (artifacts/api-server/src/lib/sms.ts). This script reproduces that signing
// so requests are accepted instead of rejected with 403.
//
// Required env:
//   WEBHOOK_URL         The exact public URL Twilio would POST to, e.g.
//                       https://staging.mediflow.example/webhooks/twilio/sms
//                       The signature is computed over this string, so it
//                       MUST match what the server reconstructs from headers.
//   TWILIO_AUTH_TOKEN   The same auth token the server validates against.
//                       Without it the script cannot produce a valid
//                       signature and every request 403s.
//
// Optional: TWILIO_FROM / TWILIO_TO phone numbers.
//
// Run standalone:
//   k6 run -e WEBHOOK_URL=https://.../webhooks/twilio/sms \
//          -e TWILIO_AUTH_TOKEN=xxxx load-tests/scenarios/twilio-webhook.js

import http from 'k6/http';
import { sleep } from 'k6';
import crypto from 'k6/crypto';
import { BASE_URL, TWILIO_FROM, TWILIO_TO, THRESHOLDS, mergeThresholds } from '../lib/config.js';
import { expectTwiml } from '../lib/checks.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: mergeThresholds(THRESHOLDS.webhook, THRESHOLDS.errorRate),
};

const WEBHOOK_URL = __ENV.WEBHOOK_URL || `${BASE_URL}/webhooks/twilio/sms`;
const AUTH_TOKEN = __ENV.TWILIO_AUTH_TOKEN || '';

export function setup() {
  if (!AUTH_TOKEN) {
    throw new Error(
      'TWILIO_AUTH_TOKEN is not set. The webhook validates an HMAC-SHA1 ' +
        'signature; without the token every request is rejected 403. ' +
        'Pass `-e TWILIO_AUTH_TOKEN=<token>`.',
    );
  }
}

// Reproduce Twilio's signing scheme: HMAC-SHA1, base64, over the URL
// concatenated with each sorted param key immediately followed by its value.
function twilioSignature(url, params) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (let i = 0; i < keys.length; i++) {
    data += keys[i] + (params[keys[i]] == null ? '' : params[keys[i]]);
  }
  return crypto.hmac('sha1', AUTH_TOKEN, data, 'base64');
}

// Form-urlencode a flat object (k6's http.post does this for objects too, but
// doing it explicitly guarantees the body matches the signed params exactly).
function formEncode(params) {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

// A mix of inbound message bodies so the run covers the opt-out, opt-in,
// help, and normal-store branches of the handler.
const BODIES = ['Hi, is my plan still active?', 'STOP', 'START', 'HELP', 'Thanks!'];

export default function () {
  const params = {
    From: TWILIO_FROM,
    To: TWILIO_TO,
    Body: BODIES[Math.floor(Math.random() * BODIES.length)],
    MessageSid: `SM${Date.now()}${Math.floor(Math.random() * 1e9)}`,
    AccountSid: 'ACloadtest',
    NumMedia: '0',
  };

  const signature = twilioSignature(WEBHOOK_URL, params);

  const res = http.post(WEBHOOK_URL, formEncode(params), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    tags: { kind: 'webhook', endpoint: 'POST /webhooks/twilio/sms' },
  });
  expectTwiml(res, 'POST /webhooks/twilio/sms');
  sleep(1);
}
