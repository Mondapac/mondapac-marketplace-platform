-- Reverts 20261126030000_ai_gateway_buyer_chat_caps: the release before G4d2 reads the buyer
-- assistant's caps from `assistant.settings` again (G4d2 carried their values forward on every new
-- assistant version), and knows neither the two settings nor the capability month counters. A cap
-- an admin changed on the AI Gateway page after the migration is not copied back: the assistant's
-- own value is in force again.
SET lock_timeout = '5s';

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
