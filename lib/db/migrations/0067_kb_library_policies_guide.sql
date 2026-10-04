-- Correct the "Policies: the agency's book of business" library guide: policies
-- can now be added from the Policies page and from a client's page. Only touches
-- the article while it still contains the stale "no Add Policy button" wording from
-- the seed, so a platform admin's own rewrite is kept.
UPDATE "kb_library_articles"
SET "content" = $kb$Where: Main > Policies (Super Admin, Agency Admin, Compliance Manager, Agent Support). Agents see a client's policies through Main > My Clients.

What it is: a list of every plan your clients are enrolled in, from the enrollments records. Columns: Policy #, Client (click to open the client), Carrier, Plan type, Status, Effectuated, Effective date and Agent.

Add a policy: click Add policy (top right), or open a client and click Add policy there. Pick the client (search by name, email or phone), the plan type, the start date and plan year (the year follows the start date until you change it). Carrier, writing agent, plan name, policy number, application date and notes are optional. Status starts as Pending; choose Active when the plan is in force. If that client already has the same carrier, plan type and year, Mediflow says so instead of adding a duplicate.

Top tiles: Active policies, Waiting on the carrier (pending), Effectuated, and Starting in 60 days. Tiles follow your filters, so the totals match the list.

Filters: search, Status, Plan type, Carrier, Agent, Effectuated, and an effective date range.

Export CSV downloads the book. Import and Export has a Policies tab for spreadsheet import.

Limits: premium and per-policy commission are not tracked here (see Commissions). There is no screen yet to edit or delete a policy once added. The Applications tab on a client shows enrollment applications received from EnrollHere/Sunfire.$kb$,
    "updated_at" = now()
WHERE "key" = 'mf-policies'
  AND "content" LIKE '%I found no Add Policy button%';
