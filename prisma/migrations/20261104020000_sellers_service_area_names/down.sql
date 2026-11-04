-- Reverses 20261104020000_sellers_service_area_names. Drops the edited names; every area then shows
-- the name its configuration holds. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "sellers"."service_area_names";
