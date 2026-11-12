-- Reverses 20261111120000_catalog_cultures. Drops the cultures with their names and category marks;
-- every definition made since is lost. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "catalog"."culture_categories";
DROP TABLE "catalog"."culture_names";
DROP TABLE "catalog"."cultures";
