-- Reverts 20261126030000_ai_gateway_buyer_chat_caps: the release before G4d2 reads the buyer
-- assistant's caps from `assistant.settings` again (G4d2 carried their values forward on every new
-- assistant version), and knows neither the two settings nor the capability month counters.
-- One transaction: a failure part way leaves nothing half-reverted (Mojtaba 3, Hassan L2).
--
-- A revert never loosens a cap silently (Hassan L1): a gateway cap stricter than the assistant's
-- latest value (a number below it; `none` is looser and is not carried) is carried back first as a
-- new assistant settings version, floor(micro-dollars / 10000) cents. The assistant's CHECK allows
-- 100 to 100000 cents a day and 100 to 2000000 a month, day not above month, so a gateway cap below
-- US$1 (0 included) is carried as 100 cents, the strictest value the column allows (looser than
-- the gateway's, unavoidably). Then the two settings' rows and history are deleted, so a looser
-- cap saved on the AI Gateway page after the migration is lost and the assistant's value returns.
BEGIN;
SET LOCAL lock_timeout = '5s';

WITH "gateway" AS (
  SELECT "market_id",
         max("tenant_id") AS "tenant_id",
         max(CASE WHEN "code" = 'ai-cap-buyer-chat-day' AND "value" ~ '^[0-9]{1,13}$'
                  THEN greatest(100, least(100000, "value"::bigint / 10000)) END) AS "day",
         max(CASE WHEN "code" = 'ai-cap-buyer-chat-month' AND "value" ~ '^[0-9]{1,13}$'
                  THEN greatest(100, least(2000000, "value"::bigint / 10000)) END) AS "month",
         (array_agg("updated_by_account_id" ORDER BY "updated_at" DESC))[1] AS "by"
    FROM "settings"."market_settings"
   WHERE "code" IN ('ai-cap-buyer-chat-day', 'ai-cap-buyer-chat-month')
   GROUP BY "market_id"
), "latest" AS (
  SELECT DISTINCT ON ("market_id") *
    FROM "assistant"."settings"
   ORDER BY "market_id", "version" DESC
), "carried" AS (
  -- A Market without an assistant version had the former defaults (1000 and 20000 cents) and
  -- every other default of that release.
  SELECT g."market_id",
         coalesce(l."tenant_id", g."tenant_id") AS "tenant_id",
         coalesce(l."version", 0) + 1 AS "version",
         coalesce(l."enabled", false) AS "enabled",
         coalesce(l."audience", 'internal') AS "audience",
         l."audience_percent",
         coalesce(l."scope", 'read-only') AS "scope",
         coalesce(l."model_tier", 'fast') AS "model_tier",
         coalesce(l."users", 'guests-and-customers') AS "users",
         coalesce(l."guest_message_limit", 20) AS "guest_message_limit",
         coalesce(l."customer_message_limit", 40) AS "customer_message_limit",
         coalesce(l."retention", '30-days') AS "retention",
         coalesce(l."reply_language", 'buyer') AS "reply_language",
         coalesce(l."daily_spend_cap_usd_cents", 1000) AS "old_day",
         coalesce(l."monthly_spend_cap_usd_cents", 20000) AS "old_month",
         coalesce(l."support_handoff", 'email-link') AS "support_handoff",
         coalesce(l."basket_proposals", false) AS "basket_proposals",
         l."welcome_text",
         g."day", g."month", g."by"
    FROM "gateway" g
    LEFT JOIN "latest" l ON l."market_id" = g."market_id"
), "next" AS (
  SELECT *,
         least("old_month", coalesce("month", "old_month")) AS "new_month",
         least("old_day", coalesce("day", "old_day"),
               least("old_month", coalesce("month", "old_month"))) AS "new_day"
    FROM "carried"
)
INSERT INTO "assistant"."settings"
       ("market_id", "version", "tenant_id", "enabled", "audience", "audience_percent", "scope",
        "model_tier", "users", "guest_message_limit", "customer_message_limit", "retention",
        "reply_language", "daily_spend_cap_usd_cents", "monthly_spend_cap_usd_cents",
        "support_handoff", "basket_proposals", "welcome_text", "changed_at", "changed_by")
SELECT "market_id", "version", "tenant_id", "enabled", "audience", "audience_percent", "scope",
       "model_tier", "users", "guest_message_limit", "customer_message_limit", "retention",
       "reply_language", "new_day", "new_month", "support_handoff", "basket_proposals",
       "welcome_text", now(), "by"
  FROM "next"
 WHERE "new_day" < "old_day" OR "new_month" < "old_month";

-- The settings rows and history of the two codes (copied or saved since). The settings tables are
-- insert-only and never deleted from (ADR-0026 decision 4); the revert alone lifts that, briefly.
ALTER TABLE "settings"."market_setting_history" DISABLE TRIGGER "market_setting_history_no_delete";
DELETE FROM "settings"."market_setting_history"
 WHERE "code" IN ('ai-cap-buyer-chat-day', 'ai-cap-buyer-chat-month');
ALTER TABLE "settings"."market_setting_history" ENABLE TRIGGER "market_setting_history_no_delete";
ALTER TABLE "settings"."market_settings" DISABLE TRIGGER "market_settings_no_delete";
DELETE FROM "settings"."market_settings"
 WHERE "code" IN ('ai-cap-buyer-chat-day', 'ai-cap-buyer-chat-month');
ALTER TABLE "settings"."market_settings" ENABLE TRIGGER "market_settings_no_delete";

-- The capability month counters (backfilled or counted since); nothing before G4d2 had one.
DELETE FROM "platform"."ai_budget_counters" WHERE "scope" = 'capability' AND "period" = 'month';

ALTER TABLE "platform"."ai_budget_reservations" DROP COLUMN IF EXISTS "capability_month";

COMMIT;
