-- Catalog: saved filters of the seller Products list (catalog design 9.2d; data design 3.28).
-- Adds the seller a filter belongs to. Existing rows are admin filters and keep NULL. A seller
-- filter is shared "with everyone" only inside its own store, so the name uniques that were per
-- Market and list become per store for seller filters.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "catalog"."saved_filters" ADD COLUMN "seller_id" UUID;

-- CreateIndex
CREATE INDEX "saved_filters_market_id_seller_id_list_key_idx"
  ON "catalog"."saved_filters"("market_id", "seller_id", "list_key");


-- Hand-written: docs/design/data/catalog.md 3.28, 7.

-- Seller-scope list keys (`seller.` prefix) carry a seller; admin list keys do not. The seller is an
-- identity/sellers id with no foreign key (the tables of another module are never joined).
ALTER TABLE "catalog"."saved_filters"
  ADD CONSTRAINT "saved_filters_scope_check" CHECK (
    ("list_key" LIKE 'seller.%') = ("seller_id" IS NOT NULL));

-- The two name uniques of the admin filters now exclude seller filters, and each has a twin per
-- seller, so two stores (or two accounts of one person in two stores) never clash on a name.
DROP INDEX "catalog"."saved_filters_owner_name_key";
DROP INDEX "catalog"."saved_filters_shared_name_key";

CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NULL;

CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NULL;

-- One name per owner, store and list, whatever its case. Also the access path of "my filters".
CREATE UNIQUE INDEX "saved_filters_seller_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "seller_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NOT NULL;

-- One name among the filters a store shares with everyone, so its tabs never repeat a name.
CREATE UNIQUE INDEX "saved_filters_seller_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "seller_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NOT NULL;

COMMENT ON COLUMN "catalog"."saved_filters"."seller_id" IS
  'The store a seller-list filter belongs to (an id of the sellers module, no foreign key); NULL for admin lists. Never changes after the insert (no column grant).';

-- Grants (section 7): unchanged. The table-level INSERT covers the new column; UPDATE stays on
-- ("visibility", "name", "updated_at"), so the seller of a filter never changes.
