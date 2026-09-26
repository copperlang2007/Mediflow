# GoHighLevel → agencyBRIDGE contact feed

Pulls contacts from a GoHighLevel sub-account into agencyBRIDGE: a one-time
**backfill** of everything, then a **scheduled pull** every 15 minutes of
contacts created or changed since the last run.

## 1. Create the Private Integration token (in GoHighLevel)

In the GHL **sub-account** (not the agency view): *Settings → Private
Integrations → Create new integration*. Grant only **View Contacts**
(`contacts.readonly`). Copy the token — GHL shows it once.

The **location id** is the sub-account id (Settings → Business Profile, or the
`/location/<id>/` part of the sub-account URL).

⚠️ Never paste the token into chat, email, or a ticket. Put it straight into
GitHub Secrets / the hosting provider as below.

## 2. Configure

| Setting | Where | Value |
|---|---|---|
| `GHL_PRIVATE_INTEGRATION_TOKEN` | **GitHub Secret** (GCP) / Render env | the token |
| `GHL_LOCATION_ID` | GitHub **Variable** / Render env | the location id |
| `GHL_SYNC_ORG_IDS` | GitHub **Variable** / Render env | the agencyBRIDGE org id(s) to sync into |

Several agencies: list their org ids and use per-org overrides
`GHL_PRIVATE_INTEGRATION_TOKEN_<ORGID>` / `GHL_LOCATION_ID_<ORGID>`.

**GCP:** re-run `scripts/deploy/gcp-bootstrap.sh` once so the
`mediflow-ghl-private-integration-token` Secret Manager placeholder exists. The
deploy workflow then writes the token into Secret Manager and mounts it on
Cloud Run; it is never stored in the image or plain env.

## 3. Run

Deploying with the settings above starts the scheduled pull. The first run is
the backfill (100 contacts per request, up to 5,000 per job; a larger account
continues automatically in follow-up jobs).

Admins can watch progress and trigger runs under **Data Migration →
GoHighLevel**: *Sync now*, or *Re-sync everything* (re-reads the whole account;
safe, nothing is deleted or overwritten).

## What gets written

- Name, email, phone, date of birth, street address, city, state, ZIP, tags, source.
- Each GHL contact is linked by its GHL id, so later updates land on the same person.
- New GHL contacts are first matched against existing agencyBRIDGE contacts
  (email or phone **plus first name**, or name + date of birth) to avoid duplicates.
- Existing agencyBRIDGE data is **never overwritten** — only blank fields are filled.
  Exception: GHL *Do Not Disturb* turns agencyBRIDGE SMS/email opt-out **on** (never off).
- Contacts without a first and last name in GHL (phone-only leads) are skipped
  and counted as "skipped".

## Troubleshooting

The status panel shows the last error. `HTTP 401/403` means the token is wrong,
revoked, or missing the `contacts.readonly` scope for that location.
