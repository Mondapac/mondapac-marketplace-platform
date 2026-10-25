-- Reverses 20261025080000_wallet_ledger_core: the grants first, then the triggers, the tables and
-- the functions. Every wallet row is lost with them. The empty schema "wallet" stays, without its
-- USAGE grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("status", "reason_code", "updated_at", "updated_by_account_id") ON TABLE "wallet"."market_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("available_minor", "held_minor", "updated_at") ON TABLE "wallet"."balances" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "resolved_at") ON TABLE "wallet"."holds" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("remaining_minor") ON TABLE "wallet"."lots" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status") ON TABLE "wallet"."accounts" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "wallet"."hold_lots" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "wallet"."postings" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "wallet"."journals" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "wallet" FROM "mondapac_app";

-- Dropping a table drops its triggers.
DROP TABLE "wallet"."market_settings";
DROP TABLE "wallet"."balances";
DROP TABLE "wallet"."hold_lots";
DROP TABLE "wallet"."holds";
DROP TABLE "wallet"."lots";
DROP TABLE "wallet"."postings";
DROP TABLE "wallet"."journals";
DROP TABLE "wallet"."accounts";
DROP FUNCTION "wallet"."guard_market_setting_update"();
DROP FUNCTION "wallet"."guard_account_update"();
DROP FUNCTION "wallet"."guard_hold_update"();
DROP FUNCTION "wallet"."guard_lot_update"();
DROP FUNCTION "wallet"."check_journal_balanced"();
DROP FUNCTION "wallet"."reject_mutation"();
