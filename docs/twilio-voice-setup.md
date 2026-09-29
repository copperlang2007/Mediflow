# Turning on calling from the browser (Twilio Voice)

This is for the agency owner. You do not need to write code. Someone with access
to your Twilio account and to the place where Mediflow's settings are kept
(your hosting dashboard) can do all of it in about 20 minutes.

Until every value below is in place, the Softphone page shows a yellow
**"Needs setup"** badge and the Call button stays off. Nothing is faked and no
call is placed. In the demo site, calling is always off.

## What you are setting up

Mediflow never lets a browser dial a number it typed. An agent picks a contact,
Mediflow checks it is OK to call (consent, do-not-call, calling hours, agent
license), and only then tells Twilio to dial the number saved on that contact.
Twilio needs six pieces of information to allow that, and one web address to
send events back to.

## The six settings

Create each in the [Twilio Console](https://console.twilio.com), then add it to
Mediflow's environment settings **using exactly these names**. Never paste the
values into email, chat or a document, and never commit them to the code.

| Setting name | Where to find or create it in Twilio | What it is |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Console home, "Account Info". Starts with `AC`. | Your Twilio account's ID. |
| `TWILIO_API_KEY_SID` | Account, then API keys & tokens, then **Create API key** (type: Standard). Starts with `SK`. | The public half of a key used only to sign calling passes. |
| `TWILIO_API_KEY_SECRET` | Shown **once**, on the same screen as the key above. Copy it straight into Mediflow's settings. | The secret half of that key. If you lose it, delete the key and make a new one. |
| `TWILIO_TWIML_APP_SID` | Voice, then Manage, then **TwiML Apps**, then **Create new TwiML App**. Starts with `AP`. | The "app" that decides what happens when a call starts. See the two web addresses below. |
| `TWILIO_VOICE_CALLER_ID` | Phone Numbers, then Manage, then Active numbers (buy one or use one you own). Enter it like `+15035550100`. | The number the person you call will see. Must be a Twilio number or one verified in Twilio. |
| `TWILIO_AUTH_TOKEN` | Console home, "Account Info", Auth Token. Text messaging already uses it, so it may be set. | Mediflow uses it to prove each call event really came from Twilio. Without it every call event is refused, so calling stays on "Needs setup". |

On the TwiML App, set:

- **Voice Request URL** (method POST): `https://YOUR-MEDIFLOW-ADDRESS/api/webhooks/twilio/voice`
- **Status Callback URL** (method POST): `https://YOUR-MEDIFLOW-ADDRESS/api/webhooks/twilio/voice-status`

Replace `YOUR-MEDIFLOW-ADDRESS` with the address agents use to open Mediflow
(no trailing slash).

## One more setting to check

This is the same one text messaging uses, so it may already be set:

| Setting name | What it is |
|---|---|
| `TWILIO_WEBHOOK_PUBLIC_HOST` | Your Mediflow address, for example `https://app.youragency.com`. It must match what you typed into the TwiML App exactly, or Twilio's signature will not verify. |

## Optional safety limits

Mediflow refuses a call that would break these. The defaults are safe; you only
need to set them to change them.

| Setting name | Default | Meaning |
|---|---|---|
| `DIAL_MAX_ATTEMPTS` | 3 | Most calls to one contact or number in the window below. |
| `DIAL_WINDOW_HOURS` | 24 | Length of that window. |
| `DIAL_REDIAL_COOLDOWN_MINUTES` | 30 | Minimum wait before calling the same contact or number again. |

## How to check it worked

1. Restart Mediflow after saving the settings.
2. Open the Softphone page. The badge should say **Browser calling: ready**.
3. Pick a contact who has documented consent and is inside calling hours, press
   **Call**, and allow the microphone when your browser asks.
4. After you hang up, choose an outcome and save. The call appears on the
   contact's timeline once, and in Recent Calls.

If the badge still says **Needs setup**, an administrator will see the names of
the settings that are missing (never their values).

## What Mediflow already does for you

- Blocks the call if the number is on **any** agency's do-not-contact list (matched
  on the last 10 digits, however the number was typed), if the contact has no
  documented consent, if it is outside 8am to 9pm in the contact's time zone,
  or if the agent is not licensed and certified.
- Caps repeat calls (see limits above) and records every refused attempt, with
  the reason, so there is an audit trail.
- Lets an agent dial only contacts assigned to them. Admins can call any contact
  in their own agency.
- Turns a "do not call again" outcome into a do-not-contact entry for that number.
- Keeps recording **off**. Nothing in the product can turn it on yet.

## What still needs a lawyer's review before real use

Mediflow's checks are technical safeguards, not legal advice, and no part of
this feature claims to make you compliant. Have your attorney or compliance
officer review these before agents use it on real beneficiaries:

1. **Call recording consent, state by state.** Some states allow recording with
   one party's consent; others (for example California, Florida, Illinois,
   Pennsylvania, Washington and several more) need everyone on the call to
   agree. Recording is off. If you ever turn it on, the notice wording, when it
   plays, and whether it is enough for each state must be approved first.
   Mediflow has a hook that plays a notice to the person you call before the
   two of you are connected, but that hook is not a compliance claim.
2. **TCPA and Do Not Call for calls.** What counts as valid consent for your
   calls, how long a consent lasts, honoring the National and state Do Not Call
   registries (Mediflow checks your own opt-out lists, **not** the national
   registry), and your own internal do-not-call policy. The consent Mediflow
   looks for is a saved date and a saved source on the contact; whether that
   record is enough is a legal question.
3. **Calling hours.** Mediflow uses 8am to 9pm in the contact's state's main
   time zone. Some states have narrower rules, and a few states span two time
   zones.
4. **CMS / TPMO call rules for Medicare marketing.** Required disclaimers,
   Scope of Appointment timing, and record-keeping periods for call data.
5. **Caller ID and call labeling.** Registration of the number you call from
   (for example STIR/SHAKEN and Twilio's business profile) so calls are less
   likely to be marked as spam.
6. **Retention of call records and notes.** Notes can contain health details;
   confirm how long you keep them and who may see them.

## For the technical person

- Endpoints: `POST /api/softphone/calls`, `GET /api/softphone/voice-token`,
  `GET /api/softphone/calls`, `PATCH /api/softphone/calls/:id`, and the Twilio
  webhooks `POST /api/webhooks/twilio/voice`, `/voice-status`, `/voice-notice`.
- Access tokens are short-lived (10 minutes), outgoing-only, and signed with the
  API key secret. They are never logged.
- The voice webhook only dials the number stored on the call session, rejects
  replays and sessions older than 2 minutes, and checks the signature with the
  same validator and host pinning as the SMS webhook.
- The web page loads the Twilio browser SDK only when someone places a call.
  The Content Security Policy already allows `*.twilio.com` for signalling.
