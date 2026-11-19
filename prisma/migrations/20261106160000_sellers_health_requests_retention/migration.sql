-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health: the retention purge (every six hours) deletes finished recount requests older than
-- 30 days. Only the purge use case issues the DELETE, and only for `done` or `failed` rows; the
-- seller's cooldown looks back minutes, so nothing reads a request that old.
GRANT DELETE ON TABLE "sellers"."seller_health_requests" TO "mondapac_app";
