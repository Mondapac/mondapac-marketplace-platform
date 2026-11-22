-- Reverses 20261122100000_ordering_seller_orders_scheduled_open_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."seller_orders_market_id_scheduled_open_window_end_idx";
