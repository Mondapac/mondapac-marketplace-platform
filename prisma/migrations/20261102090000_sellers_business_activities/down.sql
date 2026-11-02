-- Reverses 20261102090000_sellers_business_activities. Drops the seller business-activity
-- assignments and their change log; every assignment made since is lost. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "sellers"."seller_business_activity_changes";
DROP TABLE "sellers"."seller_business_activities";
