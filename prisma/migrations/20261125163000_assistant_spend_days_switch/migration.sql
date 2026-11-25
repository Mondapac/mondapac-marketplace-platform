-- Safety: a blocked statement fails instead of queueing, and none runs long.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AI Gateway G7, step 3 of 4 (docs/design/domain/platform-ai.md section 10): before the readers
-- switch to the gateway, the reconcile of 20261125150000_assistant_spend_days_expand runs again,
-- for what pods older than G7a wrote to assistant.spend_days only while that release rolled out
-- (Mojtaba, PR 1354 finding 2). Every statement only adds what is missing, so running it again
-- adds nothing twice. From this release spend_days is neither written nor read;
-- step 4 drops it (FE-20261125-ai-gateway-drop-spend-days).

-- The assistant's spend is read from the buyer chat's day counters (twice per buyer message, a
-- month at a time; Hassan PR 1356 finding 1). The key's leading period_start range would read
-- every seller's and capability's counter of the Market, so a partial index on the capability day
-- rows answers it (Mojtaba, PR 1356 finding 2). Its columns are never updated, so the counters'
-- updates stay HOT. Built under a 1 s lock wait, as reserves wait at most 1 s; the table is small.
SET lock_timeout = '1s';
CREATE INDEX IF NOT EXISTS "ai_budget_counters_capability_day_idx"
  ON "platform"."ai_budget_counters" ("market_id", "scope_key", "period_start")
  WHERE "scope" = 'capability' AND "period" = 'day';
SET lock_timeout = '5s';

-- Conversation counts: the larger of the two (spend_days counted everything until now).
INSERT INTO "assistant"."conversation_days" ("market_id", "day", "tenant_id", "conversations")
SELECT "market_id", "day", "tenant_id", "conversations"
FROM "assistant"."spend_days"
WHERE "conversations" > 0
ON CONFLICT ("market_id", "day") DO UPDATE SET
  "conversations" = GREATEST("conversation_days"."conversations", EXCLUDED."conversations");

-- Spend before the gateway counted (up to each Market's first gateway day), in one statement.
WITH "first_day" AS (
  SELECT "market_id", MIN("day") AS "day"
  FROM "platform"."ai_usage_days"
  WHERE "capability" = 'assistant.buyer-chat' AND "seller_id" IS NULL AND "calls" > 0
  GROUP BY "market_id"
), "delta" AS (
  SELECT s."market_id", s."tenant_id", s."day",
         GREATEST(0, s."spend_micro_usd" - COALESCE(u."cost_micro_usd", 0)) AS "cost",
         GREATEST(0, s."input_tokens" - COALESCE(u."input_tokens", 0)) AS "input_tokens",
         GREATEST(0, s."output_tokens" - COALESCE(u."output_tokens", 0)) AS "output_tokens"
  FROM "assistant"."spend_days" s
  LEFT JOIN "first_day" f ON f."market_id" = s."market_id"
  LEFT JOIN "platform"."ai_usage_days" u
    ON u."market_id" = s."market_id" AND u."day" = s."day"
   AND u."capability" = 'assistant.buyer-chat' AND u."seller_id" IS NULL
  WHERE f."day" IS NULL OR s."day" <= f."day"
), "days" AS (
  INSERT INTO "platform"."ai_usage_days"
    ("id", "market_id", "tenant_id", "day", "capability", "seller_id",
     "input_tokens", "output_tokens", "cost_micro_usd")
  SELECT gen_random_uuid(), "market_id", "tenant_id", "day", 'assistant.buyer-chat', NULL,
         "input_tokens", "output_tokens", "cost"
  FROM "delta"
  WHERE "cost" > 0 OR "input_tokens" > 0 OR "output_tokens" > 0
  ON CONFLICT ("market_id", "day", "capability", "seller_id") DO UPDATE SET
    "input_tokens" = "ai_usage_days"."input_tokens" + EXCLUDED."input_tokens",
    "output_tokens" = "ai_usage_days"."output_tokens" + EXCLUDED."output_tokens",
    "cost_micro_usd" = "ai_usage_days"."cost_micro_usd" + EXCLUDED."cost_micro_usd"
  RETURNING 1
)
INSERT INTO "platform"."ai_budget_counters"
  ("market_id", "tenant_id", "period", "period_start", "scope", "scope_key",
   "held_micro_usd", "spent_micro_usd")
SELECT "market_id", MIN("tenant_id"), "period", "period_start", "scope", "scope_key",
       SUM("cost"), SUM("cost")
FROM (
  SELECT "market_id", "tenant_id", 'day' AS "period", "day" AS "period_start",
         'capability' AS "scope", 'assistant.buyer-chat' AS "scope_key", "cost"
  FROM "delta"
  UNION ALL
  SELECT "market_id", "tenant_id", 'day', "day", 'market', '', "cost" FROM "delta"
  UNION ALL
  SELECT "market_id", "tenant_id", 'month', date_trunc('month', "day")::date, 'market', '', "cost"
  FROM "delta"
) AS "lines"
WHERE "cost" > 0
GROUP BY "market_id", "period", "period_start", "scope", "scope_key"
ON CONFLICT ("market_id", "period_start", "period", "scope", "scope_key") DO UPDATE SET
  "held_micro_usd" = "ai_budget_counters"."held_micro_usd" + EXCLUDED."held_micro_usd",
  "spent_micro_usd" = "ai_budget_counters"."spent_micro_usd" + EXCLUDED."spent_micro_usd";

-- The auto-off records; an existing record is kept.
INSERT INTO "platform"."ai_budget_counters"
  ("market_id", "tenant_id", "period", "period_start", "scope", "scope_key",
   "cap_reached_at", "cap_reached_period")
SELECT "market_id", "tenant_id", 'day', "day", 'capability', 'assistant.buyer-chat',
       "auto_off_at", CASE "auto_off_cap" WHEN 'monthly' THEN 'month' ELSE 'day' END
FROM "assistant"."spend_days"
WHERE "auto_off_at" IS NOT NULL
ON CONFLICT ("market_id", "period_start", "period", "scope", "scope_key") DO UPDATE SET
  "cap_reached_at" = COALESCE("ai_budget_counters"."cap_reached_at", EXCLUDED."cap_reached_at"),
  "cap_reached_period" =
    COALESCE("ai_budget_counters"."cap_reached_period", EXCLUDED."cap_reached_period");
