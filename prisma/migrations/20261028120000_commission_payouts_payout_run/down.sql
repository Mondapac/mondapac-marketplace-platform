-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261028120000_commission_payouts_payout_run: grants, the payout_holds index, the
-- triggers, their functions and the three tables (their constraints and indexes go with them).
-- The cursors and payouts written since are lost; down runs only on a throwaway or pre-data database.
REVOKE ALL ON TABLE "commission_payouts"."payout_schedule_cursors" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."payout_items" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."payouts" FROM "mondapac_app";

DROP INDEX "commission_payouts"."payout_holds_active_seller_order_idx";

DROP TABLE "commission_payouts"."payout_schedule_cursors";
DROP TABLE "commission_payouts"."payout_items";
DROP TABLE "commission_payouts"."payouts";
DROP FUNCTION "commission_payouts"."payout_schedule_cursors_guard_update"();
DROP FUNCTION "commission_payouts"."check_payout_items"();
DROP FUNCTION "commission_payouts"."payout_items_guard_update"();
DROP FUNCTION "commission_payouts"."payouts_free_items"();
DROP FUNCTION "commission_payouts"."payouts_guard_update"();
