-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261105150000_sellers_health_requests. Pending and past requests are lost; a request
-- is only a nudge to the job, so nothing else is affected.
DROP TABLE "sellers"."seller_health_requests";
