-- Catalog: saved filters (saved views) of the admin lists (catalog design 9.2d; data design 3.28).
-- A new, empty table: no existing row or table changes.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."saved_filters" (
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

-- CreateIndex
CREATE UNIQUE INDEX "saved_filters_market_id_id_key" ON "catalog"."saved_filters"("market_id", "id");


-- Hand-written: docs/design/data/catalog.md 3.28, 7.

ALTER TABLE "catalog"."saved_filters"
  ADD CONSTRAINT "saved_filters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "saved_filters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "saved_filters_visibility_check" CHECK ("visibility" IN ('me', 'everyone')),
  -- A dotted lower-case key, for example `admin.catalog.products`; the application holds the list
  -- of known keys, so a new list needs no migration.
  ADD CONSTRAINT "saved_filters_list_key_check" CHECK (
    "list_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$' AND char_length("list_key") <= 64),
  -- The name is shown as typed: trimmed, 1 to 60 characters, no control character.
  ADD CONSTRAINT "saved_filters_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60 AND "name" !~ '[[:cntrl:]]'),
  -- The payload is a JSON object of at most 2 KB; its keys are checked by the application.
  ADD CONSTRAINT "saved_filters_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 2048),
  ADD CONSTRAINT "saved_filters_position_check" CHECK ("position" >= 1),
  ADD CONSTRAINT "saved_filters_updated_check" CHECK ("updated_at" >= "created_at");

-- One name per owner and list, whatever its case (the owner's own filters and the ones shared by
-- the owner). Also the access path of "my filters of a list".
CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"));

-- One name among the filters shared with everyone, so the tabs of a list never repeat a name.
-- Also the access path of "the filters shared in this list".
CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "catalog"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone';

-- Grants (section 7): the application renames a filter and changes its visibility (the saved
-- document, owner, list and position never change after the insert: no column grant), and deletes
-- a filter (it is the admin's own preference, not a record to keep).
GRANT SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "catalog"."saved_filters" TO "mondapac_app";
