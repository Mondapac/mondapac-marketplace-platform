SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261103190000_catalog_category_attribute_links. The links are lost.
DROP TABLE "catalog"."category_attribute_links" CASCADE;
DROP TABLE "catalog"."category_attribute_link_revisions";
