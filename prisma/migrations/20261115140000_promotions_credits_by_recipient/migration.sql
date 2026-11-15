-- Promotions: a customer's credits, newest first (admin customer page, customers phase 1 package B3).
SET lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "credit_issuances_recipient_newest_idx"
  ON "promotions"."credit_issuances" ("market_id", "recipient_account_id", "created_at" DESC, "id" DESC);
