-- Reverses 20261124010000_reporting_seller_orders_delivery. The delivery method and state are lost;
-- they are derived data, filled again by the backfill's delivery pass once the migration is
-- applied again. The pass's progress rows go first, so the old kind CHECK holds.
SET lock_timeout = '5s';

REVOKE UPDATE ("delivery_method", "delivery_state") ON TABLE "reporting"."seller_orders" FROM "mondapac_app";

DELETE FROM "reporting"."backfill_progress" WHERE "kind" = 'delivery';
ALTER TABLE "reporting"."backfill_progress" DROP CONSTRAINT "backfill_progress_kind_check";
ALTER TABLE "reporting"."backfill_progress"
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds', 'ledger'));

ALTER TABLE "reporting"."seller_orders"
  DROP CONSTRAINT "seller_orders_delivery_state_check",
  DROP CONSTRAINT "seller_orders_delivery_method_check",
  DROP COLUMN "delivery_state",
  DROP COLUMN "delivery_method";
