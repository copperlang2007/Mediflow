// Shared configuration for k6 load-test scripts.
//
// All scripts read their target and credentials from environment variables so
// the same script can run against local, staging, or a throwaway perf box
// without edits. Pass them with `-e KEY=value` or export them in the shell.
//
//   BASE_URL    Base URL of the API server, including scheme. The API mounts
//               all authed routes under `/api` (see app.ts), so this should
//               be the host root, e.g. https://staging.mediflow.example
//               (NOT .../api). Default: http://localhost:3000
//
//   API_TOKEN   A valid Clerk session JWT. The API uses Clerk for auth
//               (see middlewares/requireAuth.ts -> getAuth(req)); k6 cannot
//               run Clerk's browser SDK, so a token must be minted out of
//               band and supplied here. See load-tests/README.md for how.
//
//   AGENT_ID    An agent id in the target org, used by the commissions
//               scenario (GET /agents/:id/commissions). Optional — the
//               commissions script skips if unset.
//
//   CONTACT_ID  Optional. A known contact id to exercise the read path
//               deterministically. If unset, the contact-read script
//               discovers one from GET /contacts.
//
//   TWILIO_FROM / TWILIO_TO  Optional phone numbers for the webhook script.
//               Default to placeholder E.164 numbers.

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const API_BASE = `${BASE_URL}/api`;
export const API_TOKEN = __ENV.API_TOKEN || '';
export const AGENT_ID = __ENV.AGENT_ID || '';
export const CONTACT_ID = __ENV.CONTACT_ID || '';
export const TWILIO_FROM = __ENV.TWILIO_FROM || '+15005550006';
export const TWILIO_TO = __ENV.TWILIO_TO || '+15005550001';

// Shared latency / error thresholds. Reads target p95 < 500ms, writes
// p95 < 1s, the Twilio webhook p95 < 2s (well under Twilio's 10s timeout),
// and overall error rate < 1%.
export const THRESHOLDS = {
  read: {
    'http_req_duration{kind:read}': ['p(95)<500'],
  },
  write: {
    'http_req_duration{kind:write}': ['p(95)<1000'],
  },
  webhook: {
    'http_req_duration{kind:webhook}': ['p(95)<2000'],
  },
  errorRate: {
    http_req_failed: ['rate<0.01'],
  },
};

// Merge any number of threshold objects into one.
export function mergeThresholds(...objs) {
  return Object.assign({}, ...objs);
}
