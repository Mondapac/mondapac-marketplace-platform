-- Safety: a blocked statement fails instead of queueing, and none runs long.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261125163000_assistant_spend_days_switch, so the G7a release (which reads
-- assistant.spend_days) can run again (Mojtaba, PR 1356 finding 1): what this release counted only
-- in its new homes is copied back into spend_days, each column the larger of the two, and the
-- auto-off record kept when spend_days has one. Running it again changes nothing more. The spend is
-- the buyer chat's day counter (`spent`), as this release read it.
INSERT INTO "assistant"."spend_days"
  ("market_id", "day", "tenant_id", "spend_micro_usd", "input_tokens", "output_tokens",
   "conversations", "auto_off_cap", "auto_off_at")
SELECT k."market_id", k."day", k."tenant_id",
       COALESCE(c."spent_micro_usd", 0), COALESCE(u."input_tokens", 0),
       COALESCE(u."output_tokens", 0), COALESCE(d."conversations", 0),
       CASE c."cap_reached_period" WHEN 'month' THEN 'monthly' WHEN 'day' THEN 'daily' END,
       c."cap_reached_at"
FROM (
  SELECT "market_id", "period_start" AS "day", MIN("tenant_id") AS "tenant_id"
  FROM "platform"."ai_budget_counters"
  WHERE "period" = 'day' AND "scope" = 'capability' AND "scope_key" = 'assistant.buyer-chat'
  GROUP BY "market_id", "period_start"
  UNION
  SELECT "market_id", "day", MIN("tenant_id") FROM "assistant"."conversation_days"
  GROUP BY "market_id", "day"
) k
LEFT JOIN "platform"."ai_budget_counters" c
  ON c."market_id" = k."market_id" AND c."period_start" = k."day" AND c."period" = 'day'
 AND c."scope" = 'capability' AND c."scope_key" = 'assistant.buyer-chat'
LEFT JOIN "platform"."ai_usage_days" u
  ON u."market_id" = k."market_id" AND u."day" = k."day"
 AND u."capability" = 'assistant.buyer-chat' AND u."seller_id" IS NULL
LEFT JOIN "assistant"."conversation_days" d
  ON d."market_id" = k."market_id" AND d."day" = k."day"
ON CONFLICT ("market_id", "day") DO UPDATE SET
  "spend_micro_usd" = GREATEST("spend_days"."spend_micro_usd", EXCLUDED."spend_micro_usd"),
  "input_tokens" = GREATEST("spend_days"."input_tokens", EXCLUDED."input_tokens"),
  "output_tokens" = GREATEST("spend_days"."output_tokens", EXCLUDED."output_tokens"),
  "conversations" = GREATEST("spend_days"."conversations", EXCLUDED."conversations"),
  "auto_off_cap" = COALESCE("spend_days"."auto_off_cap", EXCLUDED."auto_off_cap"),
  "auto_off_at" = COALESCE("spend_days"."auto_off_at", EXCLUDED."auto_off_at");

DROP INDEX IF EXISTS "platform"."ai_budget_counters_capability_day_idx";
