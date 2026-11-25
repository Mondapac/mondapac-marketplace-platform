SET lock_timeout = '5s';
ALTER TABLE "settings"."market_setting_history" DROP CONSTRAINT "market_setting_history_note_check";
ALTER TABLE "settings"."market_setting_history" DROP COLUMN "note";
