-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261106160000_sellers_health_requests_retention: the application role can no longer
-- delete requests.
REVOKE DELETE ON TABLE "sellers"."seller_health_requests" FROM "mondapac_app";
