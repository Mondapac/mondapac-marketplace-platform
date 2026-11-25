-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G7, step 1 of 4 (docs/design/domain/platform-ai.md section 10): assistant.spend_days
-- moves to the gateway. This migration expands:
--   1. assistant.conversation_days: the assistant's daily conversation count (the one column of
--      spend_days that is the assistant's own), filled from spend_days.
--   2. The "cap reached" record on platform.ai_budget_counters (the auto-off columns of
--      spend_days), on the capability's day row, filled from spend_days.
--   3. The buyer chat's spend that only spend_days counted (calls before the gateway counted, G2)
--      is added to the gateway's day rows and counters: per Market day, the part of spend_days
--      that platform.ai_usage_days does not hold yet. Running it again adds nothing.
-- spend_days is still written (dual write) and still read until step 3 (G7b) switches the
-- readers; step 4 drops it in a later release.

-- 1. Conversation counts.
CREATE TABLE "assistant"."conversation_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "day" DATE NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversations" INTEGER NOT NULL,

    CONSTRAINT "conversation_days_pkey" PRIMARY KEY ("market_id","day")
);

ALTER TABLE "assistant"."conversation_days"
  ADD CONSTRAINT "conversation_days_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "conversation_days_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "conversation_days_conversations_check" CHECK ("conversations" >= 0);

INSERT INTO "assistant"."conversation_days" ("market_id", "day", "tenant_id", "conversations")
SELECT "market_id", "day", "tenant_id", "conversations"
FROM "assistant"."spend_days"
WHERE "conversations" > 0;

-- 2. The cap-reached record: only on a capability's day row (the module's once-a-day notice).
ALTER TABLE "platform"."ai_budget_counters"
  ADD COLUMN "cap_reached_at" TIMESTAMPTZ(6),
  ADD COLUMN "cap_reached_period" VARCHAR(5);

ALTER TABLE "platform"."ai_budget_counters"
  ADD CONSTRAINT "ai_budget_counters_cap_reached_check" CHECK (
    ("cap_reached_at" IS NULL AND "cap_reached_period" IS NULL)
    OR ("cap_reached_at" IS NOT NULL AND "cap_reached_period" IS NOT NULL
        AND "cap_reached_period" IN ('day', 'month')
        AND "period" = 'day' AND "scope" = 'capability'));

-- The settings screen's "last auto-off": the newest record of one capability in a Market. Few rows
-- (at most one a day per capability), so a partial index.
CREATE INDEX "ai_budget_counters_cap_reached_idx"
  ON "platform"."ai_budget_counters" ("market_id", "scope_key", "cap_reached_at")
  WHERE "cap_reached_at" IS NOT NULL;

-- 3. Spend before the gateway counted. One row per Market day of the buyer chat (no seller).
CREATE TEMPORARY TABLE "g7_spend_delta" AS
SELECT s."market_id", s."tenant_id", s."day",
       GREATEST(0, s."spend_micro_usd" - COALESCE(u."cost_micro_usd", 0)) AS "cost",
       GREATEST(0, s."input_tokens" - COALESCE(u."input_tokens", 0)) AS "input_tokens",
       GREATEST(0, s."output_tokens" - COALESCE(u."output_tokens", 0)) AS "output_tokens"
FROM "assistant"."spend_days" s
LEFT JOIN "platform"."ai_usage_days" u
  ON u."market_id" = s."market_id" AND u."day" = s."day"
 AND u."capability" = 'assistant.buyer-chat' AND u."seller_id" IS NULL;

DELETE FROM "g7_spend_delta" WHERE "cost" = 0 AND "input_tokens" = 0 AND "output_tokens" = 0;

-- Day totals: cost and tokens only; spend_days never counted calls or latency.
INSERT INTO "platform"."ai_usage_days"
  ("id", "market_id", "tenant_id", "day", "capability", "seller_id",
   "input_tokens", "output_tokens", "cost_micro_usd")
SELECT gen_random_uuid(), "market_id", "tenant_id", "day", 'assistant.buyer-chat', NULL,
       "input_tokens", "output_tokens", "cost"
FROM "g7_spend_delta"
ON CONFLICT ("market_id", "day", "capability", "seller_id") DO UPDATE SET
  "input_tokens" = "ai_usage_days"."input_tokens" + EXCLUDED."input_tokens",
  "output_tokens" = "ai_usage_days"."output_tokens" + EXCLUDED."output_tokens",
  "cost_micro_usd" = "ai_usage_days"."cost_micro_usd" + EXCLUDED."cost_micro_usd";

-- Counters: settled spend is held and spent, on the capability's day, the Market's day and the
-- Market's month, as a settle writes them.
INSERT INTO "platform"."ai_budget_counters"
  ("market_id", "tenant_id", "period", "period_start", "scope", "scope_key",
   "held_micro_usd", "spent_micro_usd")
SELECT "market_id", MIN("tenant_id"), "period", "period_start", "scope", "scope_key",
       SUM("cost"), SUM("cost")
FROM (
  SELECT "market_id", "tenant_id", 'day' AS "period", "day" AS "period_start",
         'capability' AS "scope", 'assistant.buyer-chat' AS "scope_key", "cost"
  FROM "g7_spend_delta"
  UNION ALL
  SELECT "market_id", "tenant_id", 'day', "day", 'market', '', "cost" FROM "g7_spend_delta"
  UNION ALL
  SELECT "market_id", "tenant_id", 'month', date_trunc('month', "day")::date, 'market', '', "cost"
  FROM "g7_spend_delta"
) AS lines
WHERE "cost" > 0
GROUP BY "market_id", "period", "period_start", "scope", "scope_key"
ON CONFLICT ("market_id", "period_start", "period", "scope", "scope_key") DO UPDATE SET
  "held_micro_usd" = "ai_budget_counters"."held_micro_usd" + EXCLUDED."held_micro_usd",
  "spent_micro_usd" = "ai_budget_counters"."spent_micro_usd" + EXCLUDED."spent_micro_usd";

-- The auto-off records, on the capability's day row (created when the day had no gateway row).
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

DROP TABLE "g7_spend_delta";

-- Grants (database-designer): conversation counts are created and counted up, never deleted
-- (as spend_days). The counters' grants are unchanged.
GRANT SELECT, INSERT, UPDATE ON TABLE "assistant"."conversation_days" TO "mondapac_app";
