-- Never run this against production after launch: it drops every admin-editable Market setting
-- and its history. Reverses 20261101040000_settings_core: the grants first, then the tables
-- (which drops their triggers), then the function. The empty schema "settings" stays, without its
-- USAGE grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "settings"."market_setting_history" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("value", "version", "updated_at", "updated_by_account_id") ON TABLE "settings"."market_settings" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "settings" FROM "mondapac_app";

DROP TABLE "settings"."market_setting_history";
DROP TABLE "settings"."market_settings";

DROP FUNCTION "settings"."reject_mutation"();
