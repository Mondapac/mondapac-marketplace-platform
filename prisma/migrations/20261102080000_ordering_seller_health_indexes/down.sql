-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261102080000_ordering_seller_health_indexes. Only an index: no data is lost.
DROP INDEX IF EXISTS "ordering"."seller_orders_seller_ready_at_idx";
