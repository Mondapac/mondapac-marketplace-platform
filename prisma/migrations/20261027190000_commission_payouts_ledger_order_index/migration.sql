-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The ledger rows of one order, for the dispute flow (the seller orders of an order,
-- the recoverable cap): without it those reads scan every ledger row of the Market.
-- CONCURRENTLY: commission_payouts.ledger_entries holds rows, so the build takes no write lock; it
-- is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "ledger_entries_market_id_order_id_idx" ON "commission_payouts"."ledger_entries" ("market_id", "order_id");
