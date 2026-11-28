-- Reverses 20261128120000_sellers_activity_requests. Drops the seller activity requests; every
-- request made since is lost (the seller asks again). Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "sellers"."seller_activity_requests";
