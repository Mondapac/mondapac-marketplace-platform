-- Reverses 20261126230000_platform_ai_call_shadow: shadow rows lose their flag and check.
SET lock_timeout = '5s';

ALTER TABLE "platform"."ai_calls"
  DROP CONSTRAINT "ai_calls_output_check_ok_check",
  DROP CONSTRAINT "ai_calls_output_check_check",
  DROP COLUMN "output_check",
  DROP COLUMN "shadow";
