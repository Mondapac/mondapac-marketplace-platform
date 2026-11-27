-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261127060000_platform_ai_in_house_rollbacks. A served in-house call's check is
-- cleared first, so the G6c CHECK (a check only in a shadow sample) holds again; the rollbacks go
-- with their table (the stages they held off are then served as stored, as before G6d3).
LOCK TABLE "platform"."ai_calls" IN ACCESS EXCLUSIVE MODE;
UPDATE "platform"."ai_calls" SET "output_check" = NULL
  WHERE "output_check" IS NOT NULL AND "shadow_sample" IS NULL;
ALTER TABLE "platform"."ai_calls" DROP CONSTRAINT "ai_calls_output_check_ok_check";
ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_output_check_ok_check"
    CHECK ("output_check" IS NULL OR ("outcome" = 'ok' AND "shadow_sample" IS NOT NULL));

DROP TABLE "platform"."ai_in_house_rollbacks";
