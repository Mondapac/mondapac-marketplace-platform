-- Reverses 20261014134357_commission_payouts_ledger: the grants first, then the triggers, the
-- tables and the function. Every ledger row is lost with them. The empty schema
-- "commission_payouts" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "commission_payouts"."ledger_entries" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("rate_bps", "updated_at", "updated_by"), DELETE ON TABLE "commission_payouts"."seller_commission_rates" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "commission_payouts" FROM "mondapac_app";

DROP TRIGGER "ledger_entries_no_truncate" ON "commission_payouts"."ledger_entries";
DROP TRIGGER "ledger_entries_no_delete" ON "commission_payouts"."ledger_entries";
DROP TRIGGER "ledger_entries_no_update" ON "commission_payouts"."ledger_entries";
DROP TABLE "commission_payouts"."ledger_entries";
DROP TABLE "commission_payouts"."seller_commission_rates";
DROP FUNCTION "commission_payouts"."reject_mutation"();
