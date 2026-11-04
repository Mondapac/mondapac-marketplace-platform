-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261103150000_sellers_health_retention: the application role can no longer delete.
REVOKE DELETE ON TABLE "sellers"."seller_health_days" FROM "mondapac_app";
REVOKE DELETE ON TABLE "sellers"."seller_health_snapshots" FROM "mondapac_app";
