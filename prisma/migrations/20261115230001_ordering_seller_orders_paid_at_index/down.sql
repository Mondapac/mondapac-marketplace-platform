-- Reverses 20261115230001_ordering_seller_orders_paid_at_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block.
DROP INDEX CONCURRENTLY "ordering"."seller_orders_market_id_paid_at_id_idx";
