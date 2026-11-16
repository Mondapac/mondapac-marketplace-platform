-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The admin Refunds list (panel menu v2, Sales > Refunds): newest first by request
-- time, ties by id, within the Market; also serves the requested-at date filter. CONCURRENTLY:
-- ordering.refunds holds rows, so the build takes no write lock; it is alone in its file because
-- it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "refunds_market_id_requested_at_id_idx" ON "ordering"."refunds" ("market_id", "requested_at" DESC, "id" DESC);
