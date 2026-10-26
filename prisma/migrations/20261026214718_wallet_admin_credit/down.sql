-- Reverses 20261026214718_wallet_admin_credit (customer wallet package 2a): the grants, the
-- tables (with their triggers, indexes and foreign key) and the functions. Every admin credit
-- request is lost with them; the ledger rows their grants wrote stay. Never run this against
-- production after launch.
REVOKE SELECT, INSERT, UPDATE ("locked_at") ON TABLE "wallet"."admin_credit_days" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "decided_by_account_id", "decided_at", "decision_reason_code", "journal_id") ON TABLE "wallet"."admin_credit_requests" FROM "mondapac_app";

DROP TABLE "wallet"."admin_credit_days";
DROP TABLE "wallet"."admin_credit_requests";
DROP FUNCTION "wallet"."guard_admin_credit_journal"();
DROP FUNCTION "wallet"."guard_admin_credit_update"();
DROP FUNCTION "wallet"."guard_admin_credit_insert"();
