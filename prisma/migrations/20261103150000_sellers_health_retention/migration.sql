-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health retention: the purge job (every six hours) deletes daily counters and snapshots older than the
-- kept span (400 days: more than the longest window plus the recount, so no score ever reads a
-- deleted day). Nothing else may delete them; only the purge use case issues the DELETE.
GRANT DELETE ON TABLE "sellers"."seller_health_days" TO "mondapac_app";
GRANT DELETE ON TABLE "sellers"."seller_health_snapshots" TO "mondapac_app";
