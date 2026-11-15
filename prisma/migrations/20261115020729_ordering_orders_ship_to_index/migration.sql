-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. Hand-written partial index for the daily ship-to purge
-- (ordering.purge-delivered-ship-to), which pages confirmed orders that still hold a sealed
-- ship-to by (confirmed_at, id) up to the cutoff. Cleared orders leave the index, so a daily run
-- does not walk years of cleared rows. CONCURRENTLY: ordering.orders holds rows, so the build takes
-- no write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "orders_market_id_confirmed_at_id_ship_to_idx" ON "ordering"."orders" ("market_id", "confirmed_at", "id") WHERE "status" = 'confirmed' AND "ship_to_ciphertext" IS NOT NULL;
