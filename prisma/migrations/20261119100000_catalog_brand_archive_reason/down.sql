SET lock_timeout = '5s';
-- Reverses 20261119100000_catalog_brand_archive_reason. The reasons typed since are lost; the
-- column's CHECK and its UPDATE grant go with it.
ALTER TABLE "catalog"."brands" DROP COLUMN IF EXISTS "archive_reason";
