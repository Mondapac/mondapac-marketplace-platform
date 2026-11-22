-- Reverses 20261122130100_payments_stripe_events_failed_index. One statement, alone in its file: DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block, and the reversibility check sends a down file as one query, so there is no
-- SET lock_timeout here.
DROP INDEX CONCURRENTLY "payments"."stripe_events_market_id_received_at_failed_idx";
