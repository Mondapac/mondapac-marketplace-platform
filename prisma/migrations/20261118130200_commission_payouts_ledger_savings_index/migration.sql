-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The seller's savings on its exclusive customers by month read only the ledger rows
-- that carry a saving (customers phase 4b follow-up): partial, so it holds those rows only.
-- CONCURRENTLY: commission_payouts.ledger_entries holds rows, so the build takes no write lock; it
-- is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "ledger_entries_market_id_seller_id_occurred_at_saving_idx" ON "commission_payouts"."ledger_entries" ("market_id", "seller_id", "occurred_at") WHERE "saved_amount" IS NOT NULL;
