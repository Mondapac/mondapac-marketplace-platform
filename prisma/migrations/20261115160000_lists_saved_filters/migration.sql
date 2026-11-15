-- Lists: the one store of saved filters of every super list (super list phase 0, B0-1).
-- Creates the table, then copies the rows of `catalog.saved_filters` (admin and seller Products)
-- and `ordering.saved_filters` (admin and seller Orders) with their ids, so a filter keeps its
-- identity. The two old tables are not touched: they are dropped one release later, after the
-- copy is proven.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "lists";

-- CreateTable
CREATE TABLE "lists"."saved_filters" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "seller_id" UUID,
    "visibility" TEXT NOT NULL,
    "list_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_filters_market_id_id_key" ON "lists"."saved_filters"("market_id", "id");

-- CreateIndex
CREATE INDEX "saved_filters_market_id_seller_id_list_key_idx"
  ON "lists"."saved_filters"("market_id", "seller_id", "list_key");


-- Hand-written.

ALTER TABLE "lists"."saved_filters"
  ADD CONSTRAINT "saved_filters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "saved_filters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "saved_filters_visibility_check" CHECK ("visibility" IN ('me', 'everyone')),
  -- A dotted lower-case key, for example `admin.catalog.products`; the lists that exist are
  -- registered in code, so a new list needs no migration.
  ADD CONSTRAINT "saved_filters_list_key_check" CHECK (
    "list_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$' AND char_length("list_key") <= 64),
  -- The name is shown as typed: trimmed, 1 to 60 characters, no control character.
  ADD CONSTRAINT "saved_filters_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60 AND "name" !~ '[[:cntrl:]]'),
  -- The payload is a JSON object of at most 2 KB; its keys are checked by the owning module.
  ADD CONSTRAINT "saved_filters_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 2048),
  ADD CONSTRAINT "saved_filters_position_check" CHECK ("position" >= 1),
  ADD CONSTRAINT "saved_filters_updated_check" CHECK ("updated_at" >= "created_at"),
  -- Only a seller list can carry a store; an admin list never does. A seller list may leave it
  -- null (the seller order list is personal to the account, not to the store), but then it cannot
  -- be shared: there is no store to share it within.
  ADD CONSTRAINT "saved_filters_scope_check" CHECK (
    "seller_id" IS NULL OR "list_key" LIKE 'seller.%'),
  -- The seller Products list is store-scoped, as the old catalog table required for every seller
  -- list: it never exists without a store.
  ADD CONSTRAINT "saved_filters_seller_products_store_check" CHECK (
    "list_key" <> 'seller.catalog.products' OR "seller_id" IS NOT NULL),
  ADD CONSTRAINT "saved_filters_seller_share_check" CHECK (
    "visibility" = 'me' OR "list_key" NOT LIKE 'seller.%' OR "seller_id" IS NOT NULL);

-- One name per owner and list, whatever its case, among the filters that have no store. Also the
-- access path of "my filters of a list".
CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "lists"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NULL;

-- One name among the filters shared with everyone, so the tabs of a list never repeat a name.
CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "lists"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NULL;

-- The same two for a store: two stores never clash on a name.
CREATE UNIQUE INDEX "saved_filters_seller_owner_name_key"
  ON "lists"."saved_filters" ("market_id", "seller_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NOT NULL;

CREATE UNIQUE INDEX "saved_filters_seller_shared_name_key"
  ON "lists"."saved_filters" ("market_id", "seller_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NOT NULL;

COMMENT ON COLUMN "lists"."saved_filters"."seller_id" IS
  'The store a store-scoped seller-list filter belongs to (an id of the sellers module, no foreign key); NULL for admin lists and for account-scoped seller lists. Never changes after the insert (no column grant).';

-- Grants: the application renames a filter and changes its visibility (the saved document, owner,
-- store, list and position never change after the insert: no column grant), and deletes a filter
-- (it is the account's own preference, not a record to keep).
GRANT USAGE ON SCHEMA "lists" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "lists"."saved_filters" TO "mondapac_app";

-- Data copy. The owner role of the migration reads both old tables. Ids, positions and times are
-- kept, so every filter, tab and shared name stays as it was. A row that the new table's CHECKs
-- would refuse fails the migration loudly instead of being dropped.
INSERT INTO "lists"."saved_filters"
  ("id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
   "name", "payload", "position", "created_at", "updated_at")
SELECT "id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at"
  FROM "catalog"."saved_filters";

INSERT INTO "lists"."saved_filters"
  ("id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
   "name", "payload", "position", "created_at", "updated_at")
SELECT "id", "market_id", "tenant_id", "owner_account_id", NULL, "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at"
  FROM "ordering"."saved_filters";
