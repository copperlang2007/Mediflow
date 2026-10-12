-- EnrollHere call-log import: a recording whose audio Mediflow is still
-- downloading from EnrollHere's signed recording link is 'fetching'.
ALTER TABLE "call_recordings" DROP CONSTRAINT IF EXISTS "call_recordings_status_check";
--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_status_check" CHECK ("status" IN ('fetching','uploading','queued','transcribing','scored','failed'));
