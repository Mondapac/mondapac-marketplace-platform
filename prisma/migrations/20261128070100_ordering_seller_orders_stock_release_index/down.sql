-- Reverses 20261128070100_ordering_seller_orders_stock_release_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."seller_orders_market_id_stock_to_release_idx";
