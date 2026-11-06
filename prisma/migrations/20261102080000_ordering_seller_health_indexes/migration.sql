-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health feed (nightly job): the seller's orders marked ready in a few days. A
-- hand-written partial index, invisible to Prisma. ready_at is written once, when the seller
-- marks the order ready, so the cost on writes is one index entry per order. Without it the read
-- walks the seller's whole order history; with it the read touches only the window.
-- A plain CREATE INDEX blocks writes while it builds (CONCURRENTLY cannot run in a migration
-- transaction); the table is small before launch. A later index on a large table needs its own
-- out-of-transaction step.
-- (The paid-orders read needs no new index: EXPLAIN on 200,000 orders showed it drives from
-- seller_orders_market_id_seller_id_order_id_idx and joins orders by key.)
CREATE INDEX "seller_orders_seller_ready_at_idx"
  ON "ordering"."seller_orders" ("market_id", "seller_id", "ready_at")
  WHERE "ready_at" IS NOT NULL;
-- Watch: the paid read grows with a seller's lifetime orders. Past a p95 of about 50 ms or a seller
-- with about 20,000 orders, add a paid_at column on seller_orders with an index on
-- (market_id, seller_id, paid_at).
