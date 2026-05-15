// Shared response-checking helpers for k6 scripts.

import { check } from 'k6';

// Assert a response is a 2xx and (optionally) JSON-parseable. Returns the
// parsed body when `parse` is true, otherwise null. Tags failures so they
// show up distinctly in the summary.
export function expectOk(res, label, parse) {
  const ok = check(res, {
    [`${label}: status is 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  if (ok && parse) {
    try {
      return res.json();
    } catch (_e) {
      check(res, { [`${label}: body is JSON`]: () => false });
      return null;
    }
  }
  return null;
}

// Assert a created resource (201).
export function expectCreated(res, label) {
  check(res, {
    [`${label}: status is 201`]: (r) => r.status === 201,
  });
}

// Assert the Twilio webhook responded with TwiML. The handler always returns
// 200 with an XML <Response> body even on internal failure, so we check the
// content shape rather than just the status.
export function expectTwiml(res, label) {
  check(res, {
    [`${label}: status is 200`]: (r) => r.status === 200,
    [`${label}: body is TwiML`]: (r) =>
      typeof r.body === 'string' && r.body.indexOf('<Response') !== -1,
  });
}
