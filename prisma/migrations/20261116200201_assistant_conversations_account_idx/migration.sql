-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Customers management phase 2b (the customer page's assistant section): how many conversations
-- one customer had and when, read by (market, account) newest first. Conversations are purged by
-- their retention (at most 12 months) and the table is small, so the index is built in the
-- migration's own transaction.
-- CreateIndex
CREATE INDEX "conversations_market_id_account_id_started_at_idx" ON "assistant"."conversations"("market_id", "account_id", "started_at" DESC);
