-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The disputes of an order (`disputesOfOrder`, Phase 5 package 8b). The table is small (test mode,
-- one row per dispute), so the index is built in the migration's own transaction.
-- CreateIndex
CREATE INDEX "disputes_market_id_order_id_idx" ON "payments"."disputes"("market_id", "order_id");
