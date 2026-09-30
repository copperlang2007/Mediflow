# Call scoring (phase 2a: text transcripts)

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

- **No audio transcription.** It cannot listen to recordings. Upload a
  recording and you get a plain "audio transcription is not set up" message.
  Nothing is transcribed, guessed or invented. See "Next step: audio" below.
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

## Next step: audio (phase 2b)

To score recordings directly, the app needs speech-to-text. That means choosing a
vendor **with a signed HIPAA business associate agreement (BAA)**. This is the
owner's decision. Nothing is integrated yet, and no vendor is called by this
code. When you have chosen one, phase 2b can add:

- audio upload and transcription into the same transcript, score and review flow,
  keeping speaker labels from the recording channels;
- linking native Twilio calls (call sessions) to their transcripts automatically;
- live coaching during a call.

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
| Super admin, Agency admin, Compliance manager | All calls | Yes | Yes |
| Agent | Only calls linked to a softphone call **they** placed (matched by user, not by a shared agent profile) | No | No |
| Everyone else | No | No | No |

## Limits

- One file up to 1 MB; up to 50 files per import; pasted text up to 500,000
  characters.
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
(migration 0063). Endpoints are under `/api/call-scoring/`: `config`,
`transcripts` (POST, GET), `transcripts/:id` (GET), `transcripts/:id/rescore`,
`transcripts/:id/criteria/:criterionId` (PATCH), `summary`, `dnc-review` (GET),
`dnc-review/:findingId/resolve` (POST), `import` (POST).
