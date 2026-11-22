-- The refund check of a seller order recorded for the first time reads the refunds of that seller
-- order (Mojtaba, PR 10b finding 1): without this index it seq-scans reporting.refunds, which under
-- SERIALIZABLE locks the whole relation for every delivery.
-- CreateIndex
CREATE INDEX "refunds_market_id_seller_order_id_idx" ON "reporting"."refunds"("market_id", "seller_order_id");
