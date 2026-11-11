-- Reverses 20261111050000_catalog_missing_details_emails. Drops the email requests; the 7-day
-- throttle starts empty, so a seller may be asked again at once.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "catalog"."missing_details_emails";
