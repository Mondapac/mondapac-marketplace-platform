-- Dashboards v2, phase 1 (PR 3): the delivery method and the delivery state (region code) of each
-- seller order, for the orders-by-state card. Attributes of the fact, not rollup keys: no rollup
-- changes. Both are nullable without a default, so the ADD COLUMN is a catalog change only (no
-- rewrite); rows recorded before it are filled by the backfill's resumable `delivery` pass. The
-- state is a 1-to-3-character region code from the Market's `shipping.postcodeRegions`; no postcode
-- and no ship-to data is ever stored in reporting.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "reporting"."seller_orders" ADD COLUMN     "delivery_method" VARCHAR(16),
ADD COLUMN     "delivery_state" VARCHAR(3);

-- NOT VALID, then VALIDATE: the scan of the existing rows (all null) holds no exclusive lock.
ALTER TABLE "reporting"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_method_check" CHECK (
    "delivery_method" IS NULL OR "delivery_method" IN ('pickup', 'instant', 'same_day', 'scheduled')
  ) NOT VALID,
  ADD CONSTRAINT "seller_orders_delivery_state_check" CHECK (
    "delivery_state" IS NULL OR ("delivery_state" ~ '^[A-Z0-9]{1,3}$' AND "delivery_method" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "reporting"."seller_orders" VALIDATE CONSTRAINT "seller_orders_delivery_method_check";
ALTER TABLE "reporting"."seller_orders" VALIDATE CONSTRAINT "seller_orders_delivery_state_check";

-- The backfill's third kind: the pass that fills the two columns on rows recorded before them.
ALTER TABLE "reporting"."backfill_progress" DROP CONSTRAINT "backfill_progress_kind_check";
ALTER TABLE "reporting"."backfill_progress"
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds', 'ledger', 'delivery'));

-- The application role writes the two columns again with the fact (they are measures of the fact,
-- not its keys); SELECT and INSERT are already table-wide.
GRANT UPDATE ("delivery_method", "delivery_state") ON TABLE "reporting"."seller_orders" TO "mondapac_app";
