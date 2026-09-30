-- The agent profile that wrote an enrollment application (migration 0062).
--
-- PHI access for writing agents ("My clients", the audited full-application
-- view) keys on this id rather than re-matching the NPN / email stored on the
-- application at read time: agent NPN and email are not unique per org, so a
-- duplicate or reused value must never hand one agent another's application.
-- Imports resolve it when the application is stored, only when exactly one
-- agent profile in the org matches.
ALTER TABLE "enrollment_applications" ADD COLUMN IF NOT EXISTS "writing_agent_id" text
  REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enrollment_applications_writing_agent_idx
  ON enrollment_applications (writing_agent_id) WHERE writing_agent_id IS NOT NULL;--> statement-breakpoint
-- Backfill existing applications: the unique agent with the application's NPN,
-- else (no NPN on the application) the unique agent with its email.
UPDATE enrollment_applications a SET writing_agent_id = m.agent_id
FROM (
  SELECT a2.id AS app_id, min(g.id) AS agent_id
  FROM enrollment_applications a2
  JOIN agents g ON g.org_id = a2.org_id
    AND regexp_replace(coalesce(a2.agent_npn, ''), '[^0-9]', '', 'g') <> ''
    AND regexp_replace(coalesce(g.npn, ''), '[^0-9]', '', 'g') = regexp_replace(a2.agent_npn, '[^0-9]', '', 'g')
  WHERE a2.writing_agent_id IS NULL
  GROUP BY a2.id
  HAVING count(*) = 1
) m
WHERE a.id = m.app_id;--> statement-breakpoint
UPDATE enrollment_applications a SET writing_agent_id = m.agent_id
FROM (
  SELECT a2.id AS app_id, min(g.id) AS agent_id
  FROM enrollment_applications a2
  JOIN agents g ON g.org_id = a2.org_id
    AND lower(trim(g.email)) = lower(trim(a2.agent_email))
  WHERE a2.writing_agent_id IS NULL
    AND regexp_replace(coalesce(a2.agent_npn, ''), '[^0-9]', '', 'g') = ''
    AND coalesce(trim(a2.agent_email), '') <> ''
  GROUP BY a2.id
  HAVING count(*) = 1
) m
WHERE a.id = m.app_id;
