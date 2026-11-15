-- Reverses 20261115100001_ordering_orders_cancelled_ship_to_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."orders_market_id_cancelled_at_id_ship_to_idx";
