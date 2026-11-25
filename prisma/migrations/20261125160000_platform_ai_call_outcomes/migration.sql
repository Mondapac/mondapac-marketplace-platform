-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G3 (docs/design/domain/platform-ai.md section 6): an attempt may now end on the
-- provider's rate limit or with the provider refusing the request itself, so the router can move to
-- the next route on the first and never on the second. The G2 migration is merged and never edited;
-- this one widens its CHECK. Added NOT VALID then validated, so the table is not held under an
-- exclusive lock while the rows are checked.
ALTER TABLE "platform"."ai_calls" DROP CONSTRAINT "ai_calls_outcome_check";
ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_outcome_check"
    CHECK ("outcome" IN ('ok', 'timeout', 'unavailable', 'rate-limited', 'rejected')) NOT VALID;
ALTER TABLE "platform"."ai_calls" VALIDATE CONSTRAINT "ai_calls_outcome_check";
