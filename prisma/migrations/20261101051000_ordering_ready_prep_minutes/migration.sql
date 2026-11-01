-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health (late ready): the minutes the Market gave the seller to get this seller order
-- ready, frozen at placement. The promised ready-by time is derived from it (the payment time
-- plus these minutes, or the window start of a scheduled order). Null on orders placed before
-- this column existed: they have no promise and are never counted late.
ALTER TABLE "ordering"."seller_orders"
    ADD COLUMN "ready_prep_minutes" INTEGER;

-- Hand-written: 5 minutes to 2 days.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_ready_prep_minutes_check" CHECK ("ready_prep_minutes" IS NULL OR "ready_prep_minutes" BETWEEN 5 AND 2880);
