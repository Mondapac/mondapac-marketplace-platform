-- Reverses 20261115120000_ordering_orders_confirmed_account_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."orders_market_id_account_id_confirmed_idx";
