-- Reverses 20261124020100_reporting_seller_orders_buyer_first. The two flags are lost; they are
-- derived data, filled again by the backfill's buyer-first pass once the migration is applied
-- again (from ordering's frozen flags). The pass's progress rows go first, so the old kind CHECK
-- holds.
SET lock_timeout = '5s';

REVOKE UPDATE ("buyer_first_order", "buyer_first_with_seller") ON TABLE "reporting"."seller_orders" FROM "mondapac_app";

DELETE FROM "reporting"."backfill_progress" WHERE "kind" = 'buyer-first';
ALTER TABLE "reporting"."backfill_progress" DROP CONSTRAINT "backfill_progress_kind_check";
ALTER TABLE "reporting"."backfill_progress"
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds', 'ledger', 'delivery'));

ALTER TABLE "reporting"."seller_orders"
  DROP CONSTRAINT "seller_orders_buyer_first_check",
  DROP COLUMN "buyer_first_with_seller",
  DROP COLUMN "buyer_first_order";
