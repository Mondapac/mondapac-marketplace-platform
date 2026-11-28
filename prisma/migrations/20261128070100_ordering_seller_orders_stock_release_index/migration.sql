-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The worker's queue of cancelled seller orders whose stock inventory has not released
-- yet (ordering.record-shipments, every 10 seconds). Partial, so it holds only that queue (usually
-- empty). CONCURRENTLY: ordering.seller_orders holds rows, so the build takes no write lock; it is
-- alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "seller_orders_market_id_stock_to_release_idx" ON "ordering"."seller_orders" ("market_id", "cancelled_at") WHERE "cancelled_at" IS NOT NULL AND "stock_released_at" IS NULL;
