-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261128070000_ordering_seller_orders_cancelled. Dropping a column drops its CHECKs and
-- its column grant. A cancelled seller order then looks as before the fix: refunded in full, to-ship.
ALTER TABLE "ordering"."seller_orders"
  DROP COLUMN "stock_released_at",
  DROP COLUMN "cancelled_at";
