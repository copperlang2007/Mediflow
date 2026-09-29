/**
 * TwiML for the Voice webhook. Every interpolated value is either a validated
 * E.164 number or a constant, and is XML-escaped regardless.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

/** Path (relative, resolved by Twilio against the webhook URL) for Dial results. */
export const VOICE_STATUS_PATH = "/api/webhooks/twilio/voice-status";
export const VOICE_NOTICE_PATH = "/api/webhooks/twilio/voice-notice";

export const RECORDING_NOTICE_TEXT =
  "This call may be recorded for quality and compliance purposes.";

export function rejectTwiml(): string {
  return `${XML_HEAD}<Response><Reject reason="rejected"/></Response>`;
}

export function emptyTwiml(): string {
  return `${XML_HEAD}<Response></Response>`;
}

export function recordingNoticeTwiml(): string {
  return `${XML_HEAD}<Response><Say>${escapeXml(RECORDING_NOTICE_TEXT)}</Say></Response>`;
}

/**
 * Dial the STORED number only. `answerOnBridge` keeps the agent's browser
 * ringing (no billing on the callee leg until answered). `action` points the
 * Dial outcome (busy / no-answer / completed + talk time) back at our status
 * webhook.
 *
 * Recording is OFF unless `recording` is true. When it is on, the callee leg is
 * answered by a <Number url> that plays a recording notice BEFORE the two
 * parties are bridged, and only then does recording start.
 *
 * NOTE: call-recording consent law differs by state (one-party vs all-party).
 * This notice is a technical hook only and is NOT a statement that the notice
 * text or flow satisfies any state's requirements. It needs counsel review per
 * state before `recording_enabled` is ever turned on for real calls.
 */
export function dialTwiml(opts: { to: string; callerId: string; recording: boolean }): string {
  const dialAttrs = [
    `callerId="${escapeXml(opts.callerId)}"`,
    `answerOnBridge="true"`,
    `timeout="30"`,
    `action="${VOICE_STATUS_PATH}"`,
    `method="POST"`,
    ...(opts.recording ? [`record="record-from-answer-dual"`] : []),
  ].join(" ");
  const number = opts.recording
    ? `<Number url="${VOICE_NOTICE_PATH}" method="POST">${escapeXml(opts.to)}</Number>`
    : `<Number>${escapeXml(opts.to)}</Number>`;
  return `${XML_HEAD}<Response><Dial ${dialAttrs}>${number}</Dial></Response>`;
}
