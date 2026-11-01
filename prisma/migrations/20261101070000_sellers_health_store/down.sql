-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261101070000_sellers_health_store. The counters and snapshots are lost; the next
-- rollup rebuilds the counters from the other modules.
DROP TABLE "sellers"."seller_health_snapshots";
DROP TABLE "sellers"."seller_health_days";
