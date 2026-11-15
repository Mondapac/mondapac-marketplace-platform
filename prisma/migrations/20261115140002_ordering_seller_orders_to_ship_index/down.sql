-- Reverses 20261115140002_ordering_seller_orders_to_ship_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block.
DROP INDEX CONCURRENTLY "ordering"."seller_orders_market_id_to_ship_paid_at_idx";
