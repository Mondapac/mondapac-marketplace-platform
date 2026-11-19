-- Reverses 20261118100000_system_requests_approval_mode. Refuses to run while any proposal exists
-- (its activity and mode would be lost and its meaning changed): decide or remove them first.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "system_requests"."requests" WHERE "mode" = 'approval') THEN
    RAISE EXCEPTION 'system_requests: approval-mode requests exist; cannot drop the mode column';
  END IF;
END $$;

ALTER TABLE "system_requests"."request_activity"
  DROP CONSTRAINT "request_activity_kind_check",
  DROP CONSTRAINT "request_activity_body_check";
ALTER TABLE "system_requests"."request_activity"
  ADD CONSTRAINT "request_activity_kind_check" CHECK ("kind" IN ('applied', 'commented', 'approved', 'rejected', 'withdrawn')),
  ADD CONSTRAINT "request_activity_body_check" CHECK (
    ("kind" IN ('applied', 'approved') AND "body" IS NULL)
    OR ("kind" IN ('commented', 'rejected', 'withdrawn') AND char_length("body") BETWEEN 1 AND 2000)
  );

DROP INDEX "system_requests"."requests_one_open_proposal_key";

ALTER TABLE "system_requests"."requests"
  DROP CONSTRAINT "requests_mode_superseded_check",
  DROP CONSTRAINT "requests_mode_check";

ALTER TABLE "system_requests"."requests" DROP COLUMN "mode";
