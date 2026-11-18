-- Reverses 20261118150000_lists_drop_old_saved_filters: recreates the two old tables exactly as
-- the migrations 20261031110000, 20261107150000 (catalog) and 20261112200000 (ordering) left them,
-- and fills them from `lists.saved_filters` by list key, so a rollback keeps every filter.
SET lock_timeout = '5s';

CREATE TABLE "catalog"."saved_filters" (
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
CREATE UNIQUE INDEX "saved_filters_market_id_id_key" ON "catalog"."saved_filters"("market_id", "id");
CREATE INDEX "saved_filters_market_id_seller_id_list_key_idx"
  ON "catalog"."saved_filters"("market_id", "seller_id", "list_key");
ALTER TABLE "catalog"."saved_filters"
  ADD CONSTRAINT "saved_filters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "saved_filters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "saved_filters_visibility_check" CHECK ("visibility" IN ('me', 'everyone')),
  ADD CONSTRAINT "saved_filters_list_key_check" CHECK (
    "list_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$' AND char_length("list_key") <= 64),
  ADD CONSTRAINT "saved_filters_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60 AND "name" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "saved_filters_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 2048),
  ADD CONSTRAINT "saved_filters_position_check" CHECK ("position" >= 1),
  ADD CONSTRAINT "saved_filters_updated_check" CHECK ("updated_at" >= "created_at"),
  ADD CONSTRAINT "saved_filters_scope_check" CHECK (
    ("list_key" LIKE 'seller.%') = ("seller_id" IS NOT NULL));
CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NULL;
CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NULL;
CREATE UNIQUE INDEX "saved_filters_seller_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "seller_id", "list_key", "owner_account_id", lower("name"))
  WHERE "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "saved_filters_seller_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "seller_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone' AND "seller_id" IS NOT NULL;
COMMENT ON COLUMN "catalog"."saved_filters"."seller_id" IS
  'The store a seller-list filter belongs to (an id of the sellers module, no foreign key); NULL for admin lists. Never changes after the insert (no column grant).';
GRANT SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "catalog"."saved_filters" TO "mondapac_app";

CREATE TABLE "ordering"."saved_filters" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "visibility" TEXT NOT NULL,
    "list_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "saved_filters_market_id_id_key" ON "ordering"."saved_filters"("market_id", "id");
ALTER TABLE "ordering"."saved_filters"
  ADD CONSTRAINT "saved_filters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "saved_filters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "saved_filters_visibility_check" CHECK ("visibility" IN ('me', 'everyone')),
  ADD CONSTRAINT "saved_filters_list_key_check" CHECK (
    "list_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$' AND char_length("list_key") <= 64),
  ADD CONSTRAINT "saved_filters_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60 AND "name" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "saved_filters_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 2048),
  ADD CONSTRAINT "saved_filters_seller_personal_check" CHECK (
    "visibility" = 'me' OR "list_key" NOT LIKE 'seller.%'),
  ADD CONSTRAINT "saved_filters_position_check" CHECK ("position" >= 1),
  ADD CONSTRAINT "saved_filters_updated_check" CHECK ("updated_at" >= "created_at");
CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "ordering"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"));
CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "ordering"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone';
GRANT SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "ordering"."saved_filters" TO "mondapac_app";

-- Fill them from the shared store by the module a list key names.
INSERT INTO "catalog"."saved_filters"
  ("id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
   "name", "payload", "position", "created_at", "updated_at")
SELECT "id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at"
  FROM "lists"."saved_filters"
 WHERE "list_key" LIKE 'admin.catalog.%' OR "list_key" LIKE 'seller.catalog.%';
INSERT INTO "ordering"."saved_filters"
  ("id", "market_id", "tenant_id", "owner_account_id", "visibility", "list_key",
   "name", "payload", "position", "created_at", "updated_at")
SELECT "id", "market_id", "tenant_id", "owner_account_id", "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at"
  FROM "lists"."saved_filters"
 WHERE "list_key" LIKE 'admin.ordering.%' OR "list_key" LIKE 'seller.ordering.%';
