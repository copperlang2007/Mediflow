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

These limits are counted **per phone number**, not per contact. If a household
shares one number, every contact on it shares the same limit and the same wait.
That is deliberate (it is the stricter reading). When it happens, the message
says another call to this number happened recently. A call that never reached
Twilio (for example the microphone was blocked) does not count.

| Setting name | Default | Meaning |
|---|---|---|
| `DIAL_MAX_ATTEMPTS` | 3 | Most calls to one contact or number in the window below. |
| `DIAL_WINDOW_HOURS` | 24 | Length of that window. |
| `DIAL_REDIAL_COOLDOWN_MINUTES` | 30 | Minimum wait before calling the same contact or number again. |
| `DIAL_MAX_UNCLAIMED_ATTEMPTS` | 30 | Most attempts to one number in the window that never connected (for example a blocked microphone). Past this, Mediflow refuses new attempts until the window passes. |

## How to check it worked

1. Restart Mediflow after saving the settings. A super admin can open
   **System Health**: the "Texting & calling (Twilio)" card lists every setting
   with a check or a reason (never its value) and shows the exact addresses to
   paste into Twilio, with a copy button.
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
  documented consent (always required for calls, whatever your text-message
  consent setting is), if it is outside 8am to 9pm in the contact's time zone,
  or if the agent is not licensed and certified.
- Lets only agents whose profile is **active** place calls. Suspended, offboarding,
  offboarded and still-onboarding profiles are refused, and cannot borrow another
  agent's license.
- Re-checks consent, opt-outs, the contact's status, the contact's current phone
  number and calling hours (in the contact's current time zone) at the moment
  the call connects, in case something changed after the "OK to call" check.
  If the phone number was edited in between, the old number is never dialed.
- Caps repeat calls (see limits above) and records every refused attempt, with
  the reason, so there is an audit trail.
- Lets an agent dial only contacts assigned to them. Admins can call any contact
  in their own agency.
- Turns a "do not call again" outcome into a do-not-contact entry for that number,
  but only for a call the person actually answered. The entry is stored on the
  text-message channel (the opt-out list has no separate "voice" channel yet) and
  also switches off texting for that contact. That is intentional: it errs on the
  side of contacting less. A separate voice channel is a possible later follow-up.
- Keeps recording **off**. Nothing in the product can turn it on yet.

## Calling clients you moved over from GoHighLevel (owner switch)

Normally a call needs a **documented consent date and source** on the contact.
Clients moved over from GoHighLevel do not have those fields. You have told us
their consent was approved and is recorded on the call recordings, and that
do-not-contact requests live in GoHighLevel as the DND flag.

There is one switch for this: **Settings, Calling compliance, "Allow calls to
imported clients with no do-not-contact flag"**. It is **off** until an agency
admin turns it on (there is a confirmation with an acknowledgement box, and the
change is written to the audit log). Nobody else can change it.

**What it does when it is on.** A contact can be called without a documented
consent date if **all** of these are true:

- the contact is linked to a GoHighLevel contact (it came in through the sync);
- the contact is not marked do-not-contact and has no opt-out of any kind (text
  or email opt-out, or an opt-out on the number in any agency);
- the sync has **checked** that record and GoHighLevel said DND is off. A link
  that has never been refreshed by a sync is "unknown" and is **not callable**,
  and so is any link GoHighLevel has ever flagged DND, even in the rare case where
  the sync could not copy the flag onto the contact.

Everything else is as strict as before: calling hours, licensing, redial limits,
and the check again at the moment the call connects. Each call is stored with
the reason it was allowed (`documented` or `imported_ghl_recorded_call`), and the
softphone shows a small note when a call went ahead on the imported basis.

**What it does not do. Please read this.**

- **No DND flag is not the same as consent.** Mediflow cannot see the recordings;
  it is trusting what you told us.
- **The national and state do-not-call registries are not checked**, by this
  switch or by the calling feature.
- **Rules for existing customers have time limits.**
- Have your attorney or compliance counsel confirm this before you rely on it.
  Nothing here is a statement that the calls are compliant.

**A cleared DND does not re-enable calling.** Once GoHighLevel has reported DND on
a contact, Mediflow keeps it blocked even if GoHighLevel later clears the flag
(over-blocking is the safe direction, and a weakly matched contact never got a
local opt-out written). An admin has to review such contacts and record documented
consent on them. An explicit admin override is not built yet (follow-up).

**Clean up after the move.** Add a real consent date and source to each client
(the switch is a bridge, not a permanent answer), then turn the switch off.

### Before you turn it on

1. Run a **full** GoHighLevel sync (backfill from the beginning; ask us to reset
   the sync cursor). Contacts linked before this feature existed are "unknown"
   until the sync refreshes them, and the normal incremental sync does not revisit
   unchanged contacts, so without a full re-sync those clients stay **blocked**
   (that is deliberate: unknown is never treated as clear). Mediflow does not yet
   show a count of still-unknown contacts; if a client you expect to be callable
   is blocked, an un-refreshed link is the likely reason.
2. Spot-check a few clients you know are do-not-contact in GoHighLevel. Open each
   in Mediflow and try to call: they must show as **blocked**.
3. Check every agent who will call has an **active** agent profile.
4. Check all six Twilio settings above are filled in (the softphone says "ready").
5. Talk to counsel about the points above.

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
