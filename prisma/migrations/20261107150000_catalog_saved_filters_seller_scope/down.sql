-- Reverses 20261107150000_catalog_saved_filters_seller_scope (docs/design/data/catalog.md 8.3).
-- The seller filters go with the column (a development rollback); the admin filters are untouched.
SET lock_timeout = '5s';

DELETE FROM "catalog"."saved_filters" WHERE "seller_id" IS NOT NULL;

DROP INDEX "catalog"."saved_filters_seller_shared_name_key";
DROP INDEX "catalog"."saved_filters_seller_owner_name_key";
DROP INDEX "catalog"."saved_filters_shared_name_key";
DROP INDEX "catalog"."saved_filters_owner_name_key";

CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"));

CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone';

ALTER TABLE "catalog"."saved_filters" DROP CONSTRAINT "saved_filters_scope_check";
DROP INDEX "catalog"."saved_filters_market_id_seller_id_list_key_idx";
ALTER TABLE "catalog"."saved_filters" DROP COLUMN "seller_id";
