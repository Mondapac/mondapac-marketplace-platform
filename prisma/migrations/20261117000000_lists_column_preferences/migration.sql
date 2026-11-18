-- Lists: the column choice of a user per list (super list phase 0, B0-2). Until now the panels kept
-- it in the browser; here it follows the account to any browser. One row per account and list (and
-- per store for a store-scoped seller list). The module that owns the list owns the vocabulary of
-- column ids and validates it on write; the CHECKs only bound the type and size.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "lists"."column_preferences" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "seller_id" UUID,
    "list_key" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "column_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "column_preferences_market_id_id_key" ON "lists"."column_preferences"("market_id", "id");

-- Hand-written.

ALTER TABLE "lists"."column_preferences"
  ADD CONSTRAINT "column_preferences_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "column_preferences_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "column_preferences_list_key_check" CHECK (
    "list_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$' AND char_length("list_key") <= 64),
  ADD CONSTRAINT "column_preferences_scope_check" CHECK (
    "seller_id" IS NULL OR "list_key" LIKE 'seller.%'),
  -- A JSON array of at most 1 KB; the ids and their vocabulary are checked by the owning module.
  ADD CONSTRAINT "column_preferences_columns_check" CHECK (
    jsonb_typeof("columns") = 'array' AND octet_length("columns"::text) <= 1024),
  ADD CONSTRAINT "column_preferences_updated_check" CHECK ("updated_at" >= "created_at");

-- One choice per account and list; the two partial uniques are also the access path.
CREATE UNIQUE INDEX "column_preferences_owner_list_key"
  ON "lists"."column_preferences" ("market_id", "owner_account_id", "list_key")
  WHERE "seller_id" IS NULL;

CREATE UNIQUE INDEX "column_preferences_seller_owner_list_key"
  ON "lists"."column_preferences" ("market_id", "seller_id", "owner_account_id", "list_key")
  WHERE "seller_id" IS NOT NULL;

-- A preference is the account's own, so the application writes and deletes it (reset to the
-- default); only the columns and the update time change after the insert.
GRANT SELECT, INSERT, UPDATE ("columns", "updated_at"), DELETE
  ON TABLE "lists"."column_preferences" TO "mondapac_app";
