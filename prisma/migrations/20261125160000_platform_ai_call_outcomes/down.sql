-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261125160000_platform_ai_call_outcomes. The two new outcomes did not exist before:
-- their rows become 'unavailable' (a failed attempt, as G2 recorded every failure that was not a
-- timeout), so the narrower CHECK holds again. Costs and counts are kept. The table is locked
-- first, so a running G3 app cannot insert a new outcome between the UPDATE and the ADD (Mojtaba,
-- G3 review nit 4).
LOCK TABLE "platform"."ai_calls" IN ACCESS EXCLUSIVE MODE;
UPDATE "platform"."ai_calls" SET "outcome" = 'unavailable'
  WHERE "outcome" IN ('rate-limited', 'rejected');
ALTER TABLE "platform"."ai_calls" DROP CONSTRAINT "ai_calls_outcome_check";
ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_outcome_check" CHECK ("outcome" IN ('ok', 'timeout', 'unavailable'));
