# Call scoring (text transcripts and recordings)

Call scoring reads a call **transcript** and checks it against a compliance and
quality checklist. It also looks for wording that may be a request to stop
contact ("stop calling me", "take me off your list") and puts each one in front
of a person to confirm.

**It assists review. It is not legal advice, and it is not a compliance
certification.** A person should confirm anything that matters. Nothing in this
feature says a call, an agent or the agency "is compliant".

You will find it in the sidebar under **Compliance > Call scoring**.

## What it does today

- Scores pasted or uploaded transcripts (TXT, VTT, SRT or JSON) against the
  Medicare sales-call checklist or a general sales checklist.
- Scores **recordings** (ENROLLHERE downloads or any dialer's export: MP3, WAV,
  M4A and most audio formats, up to 500 MB) once Google Speech-to-Text is set up.
  See "Recordings (phase 2b)" below.
- Shows every finding with the **exact words**, **who said them** (agent, client,
  or "speaker not identified"), and **where** (time and turn). "Jump to it"
  highlights the words in the transcript.
- Catches possible do-not-contact requests in what the client said, and keeps a
  review queue of them.
- Lets a reviewer override a grade, with a note. The automatic result is never
  edited; the reviewer's decision is stored next to it.
- Imports a whole batch of transcripts for the one-time look-back.
- Runs an optional AI review for the judgment items, only when the app's
  HIPAA-covered AI is set up.

## What it does not do

- **No audio transcription until it is set up.** Until Google Speech-to-Text
  is turned on (below), a recording gets a plain "audio transcription is not
  set up" message. Nothing is transcribed, guessed or invented.
- **No live transcription yet.** Recordings are scored after the call. Live
  transcription of web-based dialers is a later phase.
- It does not add anyone to the do-not-contact list on its own. Ever. A person
  presses the button.
- It does not use anyone's race or health answers. The checklist scores only
  what the **agent** said or asked. It does not pull health details out of calls,
  and the AI is told not to judge the client's health, race or ethnicity.
- It does not replace your compliance officer's review of the checklist. The
  checklist is data (phrases and rule citations); have it reviewed before you
  rely on it for an audit.

## How a call is scored

1. **Rules first.** Phrase rules run instantly and the same way every time. They
   understand negation ("I can't promise you the best plan" is not flagged as a
   violation, just sent to a person to confirm) and time windows ("the TPMO
   disclaimer within the first minute").
2. **AI second, only if set up.** For judgment items (for example, "were the plan
   costs explained clearly") and to confirm paraphrases. Before anything is sent,
   Social Security numbers, Medicare numbers (MBI), phone numbers, card
   numbers, email addresses and dates of birth are replaced with placeholders.
   The numbers an agent must read out (1-800-MEDICARE) are kept. Names and
   street addresses are not removed, which is why AI review only ever goes
   through the HIPAA-covered provider.
3. **Fail-closed merge.** When in doubt, a person decides. The rules:

| Situation | Result |
| --- | --- |
| A required disclosure has no evidence | **Fail** |
| A critical item fails | The call **fails compliance**, whatever the score is |
| A critical item has not been graded | The call is **Needs review**, never a silent pass |
| AI says "pass" but its quoted words are not in the transcript | **Needs review** |
| AI clears a phrase the rules flagged on a critical item | **Needs review** |
| AI says "not applicable" on a critical item (required or judgment) | **Needs review** until a person confirms |
| AI is not set up, errors, or times out | Judgment items are **Needs review** |
| The file has no agent label, so a hit (or a disclosure) can't be pinned on the agent | **Needs review**, never a failure and never a pass |
| AI quotes words from a speaker who is not identified as the agent | **Needs review** |
| The only flagged words look negated, and the AI cites no verifiable words | **Needs review** |
| The scope of appointment is mentioned only after plans were discussed | **Needs review**, never a pass |
| Time-based check would fail, but the file has no timestamps | **Needs review** |
| Words found only after a stated deadline (for example the first minute) | Not credited. **Fail** with real timestamps, **Needs review** with estimated ones; the late quote is shown |
| A possible do-not-contact request is waiting for a decision | The call cannot read "Passed" |

Compliance is a gate, not an average. The quality score (0 to 100) is separate
and never outvotes a failed critical item.

### Speaker labels and timestamps

A file is only trusted to say who spoke when its labels say so ("Agent:",
"Customer:", "Dana Brooks (Agent)"). A neutral "Speaker 1" stays "speaker not
identified". If there are no labels, every turn is treated as unknown and the
score tells you so. If there are no timestamps, times are estimated from word
counts and the score tells you that too.

In a call where only some turns are labelled, the unlabelled turns are still
searched, but anything found only there is "speaker not confirmed": it goes to a
person and can neither pass nor fail the agent on its own. Phrases only match
across turns that sit next to each other in time; words from different parts of
the call are never joined into one phrase.

A speaker's role comes only from that turn's own explicit role or label. A
generic label such as "Speaker 1" never inherits a role from another turn, a
caption cue with no speaker tag is "unknown" (and is never merged with the cue
next to it), and a plain-text line without its own label is its own unknown turn,
not a continuation of the line above.

## Possible do-not-contact requests

The detector looks only at what the **client** said (or at all speech when the
file has no labels). It never looks at the agent's words, so an agent reading a
script cannot trigger it. It understands negation: "I'd never say stop calling"
does not fire.

Each hit appears in **Possible do-not-contact requests** with the exact quote.
A reviewer chooses:

- **Add to do-not-contact list**: records the opt-out the same way a STOP text or
  a "Do not call" disposition does (source "call review"), and writes an audit
  entry. The reviewer first **confirms the one number** that asked to stop (the
  number given with the call, the client's number on file, or one they type).
  Only that number is added, and a client is attached only if the client owns
  that number. If more than one client shares the number, the reviewer picks the
  right one, or searches when more share it than can be listed. Clicking twice,
  or two people clicking at once, still records exactly one opt-out.
  If the client linked to the call has an email address on file (even if the
  number confirmed is not that client's own), the screen says so (with the address masked) and a box, ticked by default, adds it
  to the email opt-out list in the same step, so a confirmed stop request does
  not leave email flowing. Unticking it adds the phone number only, and the audit
  entry records the choice. Leaving it out of the request counts as ticked.
  When the words do not say whether the client meant phone or email ("unsubscribe
  me", "take me off your list"), the screen asks the reviewer to choose; nothing
  is dropped for being unclear.
  A request that is about **email only** ("stop emailing me") is different: a
  phone opt-out would not stop email, so it goes through the email opt-out. It
  needs a linked client with an email address, adds that address to the email
  opt-out list (source "call review") and adds no phone number.
- **Not a request**: needs a short note saying why. Nothing is added.

A transcript is linked to a client by phone number only when exactly one client
in your agency has that number. Otherwise it stays unlinked and a reviewer picks
(up to 50 matching clients are listed, and the screen says when there are more).

## The look-back, step by step

You download recordings from ENROLLHERE. Audio transcription is not built yet,
so today you need **transcripts** of those calls (TXT, VTT, SRT or JSON).

1. Get transcripts for the calls you want to check. Name each file so you can
   tell which call it is (the file name is stored encrypted, not in logs).
2. Optional but useful: make a **manifest** CSV. One row per file with these
   columns (only `filename` is required):
   `filename, phone, contactId, agent, date, reference`.
   - `phone` links the call to a client when exactly one client has it.
   - `agent` can be an agent id, an email or a full name.
   - `date` can be `2025-03-01` or `03/01/2025`.
   - `reference` is for a recording id. Do not put a client's name there.
3. Open **Call scoring > Add transcripts > Look-back import**. Choose up to 50
   files (1 MB each) and the manifest. Run it. Repeat in batches.
4. Read the summary: how many were scored, how many need review, how many
   possible do-not-contact requests were found. Files already scored (same text)
   are skipped. Files that could not be read are listed with the reason.
5. Open **Possible do-not-contact requests**. For each one, read the quote and
   confirm or dismiss it. This is the important step: nothing is added to the
   list until you do it.
6. Work through the calls marked **Needs review** and grade what the automatic
   checks could not.

Bulk imports use rules only (no AI). To add AI review to one call, open it and
rescore it from the API, or paste it again once AI review is set up.

## Recordings (phase 2b)

On **Call scoring > Add calls > Score a recording**, choose the file and its
channel layout, then **Upload and score**. The file goes straight from the
browser to the private Cloud Storage bucket (it never passes through the app
server, so long calls are fine). Google Speech-to-Text transcribes it, usually
in a few minutes, and the call is then scored exactly like a transcript. The
**Recent recordings** list shows where each one is and opens the scored call.

**Who is speaking.** Pick the channel layout that matches the file:

- **One track** (most downloads): speakers are told apart by voice and shown as
  "Speaker 1" / "Speaker 2". Roles are never guessed from what was said, so
  agent-only checks are marked for review, as with an unlabelled transcript.
- **Stereo, agent on the left / right**: each side is transcribed separately and
  labelled Agent / Client. Use this whenever the dialer can export dual-channel
  audio; scoring is much more precise.

Turn times on a recording are approximate (to the end of each sentence), not
word by word: word timing would cut Google's limit to 20-minute calls.

**If something goes wrong** the recording shows **Failed** with a plain reason
(for example "No speech was found", or a permission problem in the setup).
Google's own error text is never shown, because it can name the bucket.

### Setting up Google Speech-to-Text (one time)

Speech-to-Text is covered by the Google Cloud BAA; confirm the BAA is accepted
for the project before turning this on.

1. In the Google Cloud project that runs the app, enable the **Cloud
   Speech-to-Text API**.
2. Give the app's Cloud Run service account the **Cloud Speech Client** role
   (`roles/speech.client`), and the Speech-to-Text service agent
   (`service-PROJECT_NUMBER@gcp-sa-speech.iam.gserviceaccount.com`) **Storage
   Object Viewer** on the private bucket, since Google reads the recording as
   that agent. The runtime service account also needs **Service Account Token
   Creator** on itself, because upload links are signed through IAM.
3. Allow the browser to upload to the bucket (CORS). Without this every upload
   fails. `scripts/deploy/gcp-bootstrap.sh` does steps 1-3 when you run it with
   `APP_ORIGIN=https://your-app-address`. To do it by hand, save this as
   `cors.json`, with your app's address:

   ```json
   [{ "origin": ["https://your-app-address"], "method": ["PUT"], "responseHeader": ["Content-Type", "x-goog-if-generation-match"], "maxAgeSeconds": 3600 }]
   ```

   then run `gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json`.
4. Turn it on. On Cloud Run, set the GitHub Actions repository variable
   `SPEECH_TO_TEXT_PROVIDER` to `google` (and optionally
   `CALL_RECORDINGS_DAILY_LIMIT`); the deploy workflow passes them to the
   service and always sets `GOOGLE_CLOUD_PROJECT`. A manual edit on the Cloud
   Run service is erased by the next deploy. On other hosts set:

   | Setting | Value |
   | --- | --- |
   | `SPEECH_TO_TEXT_PROVIDER` | `google` (turns the feature on) |
   | `GOOGLE_CLOUD_PROJECT` | the project ID (optional on Cloud Run) |
   | `SPEECH_LOCATION` | optional, default `us` (data stays in the US) |
   | `SPEECH_MODEL` | optional, default `chirp_3`; use `long` if your region lacks it |
   | `CALL_RECORDINGS_DAILY_LIMIT` | optional, default `300` recordings per agency per 24 hours (a ceiling on Speech-to-Text spend) |

   `PRIVATE_OBJECT_DIR` must already be set (it is for document storage).
5. Open Call scoring: the **Audio transcription** box should say **Set up**.
   Upload a short test call before sending real ones.

Recordings are kept encrypted in the private bucket with the same 10-year
"retain until" date as transcripts; the file name and phone number are stored
only inside encrypted details.

**Still to come:** live transcription for web-based dialers, and linking native
softphone calls to their recordings automatically.

## Retention and privacy

- Transcript text, quotes, reviewer notes and the upload's file name are stored
  **encrypted** (the same field encryption as Medicare IDs). The phone number
  given with an upload is kept only inside that encrypted text. Only a keyed
  digest of the original speech is kept for recognising a re-upload of the same
  call; two calls that differ only in a masked value (a phone number or a date
  of birth) are treated as different calls, and two people uploading the same
  call at once still produce one transcript.
- Each transcript carries a "retain until" date **no sooner than 10 years** after
  it was created, matching the CMS record-retention floor. Nothing is deleted
  automatically, and there is no delete button. A purge job would need an
  explicit decision first.
- Scored results are append-only: the database refuses to edit a stored score or
  finding. A rescore adds a new automatic result; the old one and any earlier
  reviews stay as history (reviews are not carried onto the new result).
- Reading a transcript is audited. Audit entries hold counts and states, never
  the text, a quote, a phone number, a file name or a note.
- Every route requires sign-in and MFA (mandatory for every user), and stays
  inside your agency.

## Who can do what

| Role | Read | Upload / rescore / import | Override grades / resolve do-not-contact |
| --- | --- | --- | --- |
| Super admin, Agency admin, Compliance manager | All calls | Yes (including recordings) | Yes |
| Agent | Only calls linked to a softphone call **they** placed (matched by user, not by a shared agent profile) | No | No |
| Everyone else | No | No | No |

## Limits

- One transcript file up to 1 MB; up to 50 files per import; pasted text up to
  500,000 characters. One recording up to 500 MB and about an hour of audio
  (longer calls: split them); 300 recordings per agency per day by default. A
  transcription that runs longer than 6 hours is stopped, and a background sweep
  every 10 minutes restarts any that stalled.
- Known follow-up: at very large volumes (tens of thousands of transcripts) the
  list scans in batches of 500 and assembles the effective result in memory. The
  next step is to push the rubric, compliance and open-request filters into SQL.
  It is bounded (and says so when cut off) but not built in this first version.
- The pass mark shown for a call is the one from the checklist version it was
  scored under. If the built-in checklist has changed since, no pass mark is
  shown and the screen says the version changed.
- The list and summary look at up to 5,000 transcripts that match your filters
  (newest first; filters are applied while scanning, so an old match is not
  hidden behind newer ones) and say so when they are cut off. The list and the
  do-not-contact queue are paged 50 at a time.
- The checklist is a starting point. Its rule citations point at the section that
  governs each check; where an exact paragraph was uncertain, only the section is
  cited.

## For developers

Code lives in `artifacts/api-server/src/lib/callScoring/` (rules, DNC detector,
rubrics as data, redaction, fail-closed merge, parsing, storage) and
`routes/callScoring.ts`. The web page is `pages/call-scoring.tsx`. Tables are
`call_transcripts`, `call_scores`, `call_score_findings`, `call_score_reviews`
(migration 0063) and `call_recordings` (migration 0064). Recordings:
`lib/callScoring/speech.ts` (Google Speech-to-Text v2 batch),
`lib/callScoring/recordings.ts` (one idempotent step per run of the
`transcribe-recording` job, `workers/transcribeRecording.ts`), and
`components/call-scoring/RecordingUpload.tsx`. Endpoints are under `/api/call-scoring/`: `config`,
`transcripts` (POST, GET), `transcripts/:id` (GET), `transcripts/:id/rescore`,
`transcripts/:id/criteria/:criterionId` (PATCH), `summary`, `dnc-review` (GET),
`dnc-review/:findingId/resolve` (POST), `import` (POST),
`recordings/upload-url` (POST), `recordings/:id/uploaded` (POST), `recordings` (GET).
