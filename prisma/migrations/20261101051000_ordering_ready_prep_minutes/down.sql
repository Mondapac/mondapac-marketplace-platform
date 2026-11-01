-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261101051000_ordering_ready_prep_minutes. The frozen preparation minutes are lost.
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_ready_prep_minutes_check",
  DROP COLUMN "ready_prep_minutes";
