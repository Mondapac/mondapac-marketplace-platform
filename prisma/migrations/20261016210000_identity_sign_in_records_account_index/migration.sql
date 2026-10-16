-- CreateIndex
CREATE INDEX "sign_in_records_market_id_account_id_occurred_at_idx" ON "identity"."sign_in_records"("market_id", "account_id", "occurred_at");
