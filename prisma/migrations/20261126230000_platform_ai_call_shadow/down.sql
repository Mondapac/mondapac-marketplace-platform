-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261126230000_platform_ai_call_shadow. Shadow calls are deleted first: without their flag
-- the G5e scorecard would count them as calls the in-house model served (Mojtaba, G6c review 1). The
-- day rows keep their cost, as the budget counters do. Dropping a column drops its CHECKs.
LOCK TABLE "platform"."ai_calls" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "platform"."ai_calls" WHERE "shadow";
ALTER TABLE "platform"."ai_calls"
  DROP COLUMN "output_check",
  DROP COLUMN "shadow_sample",
  DROP COLUMN "shadow";
