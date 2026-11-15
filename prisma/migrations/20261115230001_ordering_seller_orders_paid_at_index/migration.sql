-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The admin Shipments and Invoices lists: newest payment first, ties by id, within
-- the Market, paid seller orders only; also serves the paid-at date filter and the totals.
-- CONCURRENTLY and alone in its file: ordering.seller_orders holds rows.
CREATE INDEX CONCURRENTLY "seller_orders_market_id_paid_at_id_idx" ON "ordering"."seller_orders" ("market_id", "paid_at" DESC, "id" DESC) WHERE "paid_at" IS NOT NULL;
