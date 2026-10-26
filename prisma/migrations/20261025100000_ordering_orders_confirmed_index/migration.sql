-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. Hand-written partial index for the nightly bought-together job
-- (ordering.rebuild-offer-pairs), which pages confirmed orders by (confirmed_at, id) inside the
-- 90-day window. CONCURRENTLY: ordering.orders may hold rows, so the build takes no write lock;
-- it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "orders_market_id_confirmed_at_id_idx" ON "ordering"."orders" ("market_id", "confirmed_at", "id") WHERE "status" = 'confirmed';
