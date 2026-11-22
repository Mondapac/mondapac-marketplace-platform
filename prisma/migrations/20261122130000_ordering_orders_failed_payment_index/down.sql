-- Reverses 20261122130000_ordering_orders_failed_payment_index. One statement, alone in its file: DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block, and the reversibility check sends a down file as one query, so there is no
-- SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."orders_market_id_cancelled_at_failed_payment_idx";
