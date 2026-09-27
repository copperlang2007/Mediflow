# Omnichannel Campaigns (email + SMS) — setup

The **Omnichannel Campaigns** page (Sales Tools → Omnichannel Campaigns,
`/campaigns`) sends marketing email through **Resend** and marketing texts
through **Twilio**, using the same credentials as the rest of the app. Until a
piece below is configured, the page says so plainly ("Needs setup" / "Connect
tracking") and the API refuses to send — nothing is faked.

## 1. Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `RESEND_API_KEY` | Sending email | Already used for system email. |
| `EMAIL_FROM_ADDRESS` | Sending email | Must be on a domain verified in Resend. The display name is the agency name from campaign settings. |
| `APP_BASE_URL` | Unsubscribe links, SMS status callbacks | Public origin of the app, e.g. `https://app.example.com` (no trailing slash). Already used for invitation links. |
| `CAMPAIGN_UNSUBSCRIBE_SECRET` | Email campaigns (required) | Random string, **at least 32 characters** (`openssl rand -hex 32`). Signs every unsubscribe link. Rotating it breaks links in email already sent, so rotate only if it leaks. |
| `RESEND_WEBHOOK_SECRET` | Email tracking (delivered / opened / clicked / bounced / complaints) | The `whsec_…` signing secret Resend shows for the webhook endpoint. If unset, the webhook endpoint rejects every call (503) and the page shows "Connect tracking" instead of rates. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Sending SMS | Already used by the SMS inbox. The auth token also validates status callbacks. |
| `TWILIO_WEBHOOK_PUBLIC_HOST` | SMS tracking | Optional; falls back to `APP_BASE_URL`. Must match the host Twilio calls exactly, or signatures fail. |
| `CAMPAIGN_SEND_RATE_PER_SECOND` | Throttling | Optional. Default 10/s for email and 1/s for SMS (a single long-code number). Raise for a toll-free / 10DLC number with higher throughput. |

Put secrets in the hosting provider's secret store (GitHub Secrets for GCP,
Render environment for Render). Never paste them into chat or tickets.

## 2. In-app settings (per agency)

On the page, open **Settings** (top right) and fill in:

- **Agency name** — shown as the email sender name and in the footer.
- **Mailing address** — a valid physical postal address. **CAN-SPAM requires
  it in every marketing email**; email campaigns cannot be sent until it is set.
- **Reply-to email** (optional).
- **Default time zone** — used for SMS quiet hours when a client has no state
  on file.

Only super admins and agency admins can change these, send, schedule or cancel
a campaign, or re-subscribe someone to email. Agent support staff can build
drafts. Every send, cancel, settings change, unsubscribe and re-subscribe is
written to the audit log.

## 3. Connect tracking

### Email (Resend)

1. Resend dashboard → **Webhooks** → **Add endpoint**.
2. URL: `https://<your app>/api/campaigns/v1/webhooks/resend`
3. Events: `email.delivered`, `email.opened`, `email.clicked`,
   `email.bounced`, `email.complained`.
4. Copy the signing secret into `RESEND_WEBHOOK_SECRET` and redeploy.
5. Opens/clicks are only reported if open and click tracking are turned on for
   the sending domain in Resend (Domains → your domain → Tracking).

A spam complaint is treated as an unsubscribe.

### SMS (Twilio)

Nothing to configure in the Twilio console: each campaign text is sent with a
`StatusCallback` pointing at
`https://<your app>/api/campaigns/v1/webhooks/twilio-status`, signed with the
account auth token. Twilio reports `delivered`, `undelivered` and `failed`.
SMS has no open tracking.

## 4. What the app does for compliance

**Email (CAN-SPAM / RFC 8058)**

- Footer with agency name, mailing address and a per-recipient **unsubscribe
  link**. The link carries an HMAC-signed token (no email address in it, not
  guessable); invalid links all get the same generic page.
- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers, so Gmail/Yahoo show their native unsubscribe button.
- The public unsubscribe endpoint (`/api/campaigns/v1/unsubscribe/<token>`)
  needs no login, is rate-limited per IP, sets the contact's email opt-out,
  adds the address to the agency's email suppression list and writes an audit
  entry.
- Drip-sequence emails get the same footer and headers once the settings above
  are in place.

**SMS (TCPA)**

- Only contacts with a phone number who have not opted out are texted. The
  STOP list is checked for every recipient right before sending.
- The first campaign text a client receives ends with "Reply STOP to opt out."
- **Quiet hours**: texts go out only between 8am and 9pm in the client's local
  time, worked out from the state on their contact record (states spanning two
  zones use the zone most residents are in). Clients with no state use the
  agency's default time zone. Recipients outside the window wait for the next
  window automatically.
- Opt-outs are never reversed from the UI. A client who replied STOP is
  re-subscribed only by texting START (handled by the existing inbound SMS
  webhook).

**Audience**

- Opted-out contacts (email flag / suppression list, or SMS flag / STOP list)
  are excluded before sending and recorded on the campaign as
  "skipped — opted out", so there is a record of who was deliberately not
  contacted.
- `do_not_contact` and deleted contacts are never included.
- Health conditions and race are not available as audience filters.

## 5. How sending works

`POST /api/campaigns/:id/send` marks the campaign scheduled and enqueues the
`campaign-send` pg-boss job (at the scheduled time, if one was chosen). The job
snapshots the audience into `campaign_recipients`, then sends up to 500
messages per run at the configured rate and re-enqueues itself until done.
Each recipient is claimed in the database before the provider is called, so a
retried or duplicated job never sends anyone the same campaign twice. Each
message also appears on the client's timeline (message threads).

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| "Email sending isn't set up yet" | `RESEND_API_KEY` missing. |
| "Add your agency's mailing address…" | Settings → Mailing address is empty. |
| "Unsubscribe links aren't set up yet" | `CAMPAIGN_UNSUBSCRIBE_SECRET` (≥ 32 chars) or `APP_BASE_URL` missing. |
| Tracking tab says "Connect tracking" | `RESEND_WEBHOOK_SECRET` (email) or `TWILIO_AUTH_TOKEN` + public host (SMS) missing. |
| Resend webhook deliveries fail with 401 | Wrong secret, or a proxy is rewriting the JSON body. |
| Twilio callbacks rejected with 403 | `TWILIO_WEBHOOK_PUBLIC_HOST` / `APP_BASE_URL` does not match the URL Twilio calls. |
| SMS campaign stuck in "Sending" overnight | Quiet hours — it resumes at 8am in each recipient's time zone. |
