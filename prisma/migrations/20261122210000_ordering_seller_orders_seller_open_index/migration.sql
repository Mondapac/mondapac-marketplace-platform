-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's seller tasks (dashboards upgrade, phase 1, PR 6) count one seller's
-- open paid orders: late, to get ready today, and ready pickups not collected. Every one of those
-- counts is held to orders not delivered and not refunded in full, so the index is partial and
-- holds only the open orders, led by the seller. CONCURRENTLY: ordering.seller_orders holds rows,
-- so the build takes no write lock; it is alone in its file because it cannot run inside a
-- transaction.
CREATE INDEX CONCURRENTLY "seller_orders_market_id_seller_id_open_idx" ON "ordering"."seller_orders" ("market_id", "seller_id") WHERE "fulfilment" <> 'delivered' AND "paid_at" IS NOT NULL AND "refunded_in_full" = false;
