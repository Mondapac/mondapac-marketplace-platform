-- Reverses 20261025100000_ordering_orders_confirmed_index. One statement, alone in its file:
-- DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check sends
-- a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."orders_market_id_confirmed_at_id_idx";
