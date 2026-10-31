-- Reverses 20261031184442_catalog_business_activities. Drops the business activities with their
-- names and category links; every definition made since is lost. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "catalog"."business_activity_categories";
DROP TABLE "catalog"."business_activity_names";
DROP TABLE "catalog"."business_activities";
