-- System requests: actions that wait for approval (owner decision of 18 Nov 2026). A delete, a
-- merge or an import in a reviewed area is not applied when the admin asks for it: it opens a
-- request in approval mode, and only another admin's approval applies it. A reject or withdraw of
-- such a request changes nothing (its status is `reverted`, as for a reverted change).
--   1. requests.mode: `review` (every request so far) or `approval`. No column grant: the
--      application inserts it and never updates it.
--   2. A proposal changes nothing, so it supersedes nothing and is never superseded.
--   3. At most one open proposal per subject (the module refuses a second one).
--   4. request_activity.kind `proposed`: the first line of a proposal (as `applied` of a change).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "system_requests"."requests" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'review';

ALTER TABLE "system_requests"."requests"
  ADD CONSTRAINT "requests_mode_check" CHECK ("mode" IN ('review', 'approval')),
  ADD CONSTRAINT "requests_mode_superseded_check" CHECK ("mode" = 'review' OR "superseded_by_request_id" IS NULL);

-- CreateIndex (hand-written: partial)
CREATE UNIQUE INDEX "requests_one_open_proposal_key" ON "system_requests"."requests"("market_id", "subject_kind", "subject_ref")
  WHERE "mode" = 'approval' AND "status" = 'open';

ALTER TABLE "system_requests"."request_activity"
  DROP CONSTRAINT "request_activity_kind_check",
  DROP CONSTRAINT "request_activity_body_check";
ALTER TABLE "system_requests"."request_activity"
  ADD CONSTRAINT "request_activity_kind_check" CHECK ("kind" IN ('applied', 'proposed', 'commented', 'approved', 'rejected', 'withdrawn')),
  ADD CONSTRAINT "request_activity_body_check" CHECK (
    ("kind" IN ('applied', 'proposed', 'approved') AND "body" IS NULL)
    OR ("kind" IN ('commented', 'rejected', 'withdrawn') AND char_length("body") BETWEEN 1 AND 2000)
  );
