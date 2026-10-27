-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The lines of one seller order, for the delivered-seller-orders read that reviews
-- asks of ordering (ordering.my-delivered-seller-orders): without it that read scans every line of
-- the Market. CONCURRENTLY: ordering.order_lines holds rows, so the build takes no write lock; it
-- is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "order_lines_market_id_seller_order_id_idx" ON "ordering"."order_lines" ("market_id", "seller_order_id");
