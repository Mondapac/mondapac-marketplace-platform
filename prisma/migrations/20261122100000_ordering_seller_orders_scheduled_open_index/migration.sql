-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's late-delivery count (dashboards upgrade, phase 1) reads the paid,
-- scheduled seller orders not delivered and not refunded in full, on the end of their window:
-- partial, so it holds only the open scheduled orders. CONCURRENTLY: ordering.seller_orders holds
-- rows, so the build takes no write lock; it is alone in its file because it cannot run inside a
-- transaction.
CREATE INDEX CONCURRENTLY "seller_orders_market_id_scheduled_open_window_end_idx" ON "ordering"."seller_orders" ("market_id", "delivery_window_end") WHERE "delivery_method" = 'scheduled' AND "fulfilment" <> 'delivered' AND "paid_at" IS NOT NULL AND "refunded_in_full" = false;
