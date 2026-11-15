-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The admin Shipments list's working tabs (To prepare, Ready, Refunded) and their
-- counts: the paid seller orders not shipped yet, newest payment first. The set stays small
-- (orders leave it when shipped), so the tabs and counts never walk the whole Market.
-- CONCURRENTLY and alone in its file: ordering.seller_orders holds rows.
CREATE INDEX CONCURRENTLY "seller_orders_market_id_to_ship_paid_at_idx" ON "ordering"."seller_orders" ("market_id", "paid_at" DESC, "id" DESC) WHERE "fulfilment" = 'to-ship' AND "paid_at" IS NOT NULL;
