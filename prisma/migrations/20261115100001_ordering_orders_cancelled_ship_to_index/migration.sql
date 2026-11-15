-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. Hand-written partial index for the second phase of the daily ship-to purge
-- (ordering.purge-delivered-ship-to; owner decision 2026-11-15, 03:42Z): cancelled orders that
-- still hold a sealed ship-to, paged by (cancelled_at, id) up to the cutoff. Cleared orders leave
-- the index. CONCURRENTLY: ordering.orders holds rows, so the build takes no write lock; it is
-- alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "orders_market_id_cancelled_at_id_ship_to_idx" ON "ordering"."orders" ("market_id", "cancelled_at", "id") WHERE "status" = 'cancelled' AND "ship_to_ciphertext" IS NOT NULL;
