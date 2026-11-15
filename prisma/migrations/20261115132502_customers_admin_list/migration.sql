-- Customers admin list (phase 1, package B2): saved filters of the admin Customers list, sort indexes
-- on the stats read model, and a foreign key from a stats row to its directory row so the list can
-- read both in one query. The stats table is new (package B1) and rebuilt nightly from `ordering`.

-- Safety (docs/design/data): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- A stats row without a directory row cannot be shown and is rebuilt by the next sync: drop it
-- before the key goes on.
DELETE FROM "customers"."customer_stats" s
 WHERE NOT EXISTS (SELECT 1 FROM "customers"."customer_directory" d
                    WHERE d."market_id" = s."market_id" AND d."account_id" = s."account_id");

-- CreateTable
CREATE TABLE "customers"."saved_filters" (
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
CREATE UNIQUE INDEX "saved_filters_market_id_id_key" ON "customers"."saved_filters"("market_id", "id");

-- CreateIndex
CREATE INDEX "customer_stats_market_id_order_count_idx" ON "customers"."customer_stats"("market_id", "order_count" DESC);

-- CreateIndex
CREATE INDEX "customer_stats_market_id_spent_minor_idx" ON "customers"."customer_stats"("market_id", "spent_minor" DESC);

-- AddForeignKey
ALTER TABLE "customers"."customer_stats" ADD CONSTRAINT "customer_stats_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- Hand-written: the saved filters table follows `ordering.saved_filters` (data design 3.15).
ALTER TABLE "customers"."saved_filters"
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
  ADD CONSTRAINT "saved_filters_updated_check" CHECK ("updated_at" >= "created_at");

-- One name per owner and list, whatever its case.
CREATE UNIQUE INDEX "saved_filters_owner_name_key"
  ON "customers"."saved_filters" ("market_id", "list_key", "owner_account_id", lower("name"));

-- One name among the filters shared with everyone.
CREATE UNIQUE INDEX "saved_filters_shared_name_key"
  ON "customers"."saved_filters" ("market_id", "list_key", lower("name"))
  WHERE "visibility" = 'everyone';

-- Grants: the application renames a filter and changes its visibility; the saved document, owner,
-- list and position never change after the insert. A filter is the account's own preference, so it
-- can be deleted.
GRANT SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "customers"."saved_filters" TO "mondapac_app";
