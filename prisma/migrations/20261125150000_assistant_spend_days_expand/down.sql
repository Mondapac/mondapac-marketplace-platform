-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261125150000_assistant_spend_days_expand. assistant.spend_days was never changed, so
-- it still holds every count. The spend this migration added to the gateway's day rows and
-- counters stays: it is real spend, and the up migration adds only what is missing, so running it
-- again adds nothing twice.
REVOKE SELECT, INSERT, UPDATE ON TABLE "assistant"."conversation_days" FROM "mondapac_app";
DROP TABLE "assistant"."conversation_days";

DROP INDEX "platform"."ai_budget_counters_cap_reached_idx";
ALTER TABLE "platform"."ai_budget_counters"
  DROP CONSTRAINT "ai_budget_counters_cap_reached_check",
  DROP COLUMN "cap_reached_period",
  DROP COLUMN "cap_reached_at";
