-- Safety (docs/design/data/inventory.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "inventory";

-- CreateTable
CREATE TABLE "inventory"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "inventory"."seller_inventories" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "low_stock_threshold" INTEGER,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."sources" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" JSONB,
    "time_zone" TEXT,
    "is_default" BOOLEAN NOT NULL,
    "priority" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_inventories_market_id_seller_id_key" ON "inventory"."seller_inventories"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_market_id_seller_id_priority_key" ON "inventory"."sources"("market_id", "seller_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "sources_market_id_id_seller_id_key" ON "inventory"."sources"("market_id", "id", "seller_id");

-- AddForeignKey
ALTER TABLE "inventory"."sources" ADD CONSTRAINT "sources_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "inventory"."seller_inventories"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/inventory.md sections 2 (C1, C5, C6), 3.1,
-- 3.2 and 3.3. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "inventory"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^inventory\.[a-z0-9-]+$');

ALTER TABLE "inventory"."seller_inventories"
  ADD CONSTRAINT "seller_inventories_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_inventories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_inventories_low_stock_threshold_check" CHECK (
    "low_stock_threshold" IS NULL OR "low_stock_threshold" BETWEEN 0 AND 99),
  ADD CONSTRAINT "seller_inventories_version_check" CHECK ("version" >= 1);

ALTER TABLE "inventory"."sources"
  ADD CONSTRAINT "sources_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sources_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sources_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 80 AND "name" = btrim("name")),
  ADD CONSTRAINT "sources_address_check" CHECK (
    "address" IS NULL OR jsonb_typeof("address") = 'object'),
  ADD CONSTRAINT "sources_time_zone_check" CHECK (
    "time_zone" IS NULL
    OR "time_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  ADD CONSTRAINT "sources_priority_check" CHECK ("priority" >= 1);

-- Hand-written (database-designer): docs/design/data/inventory.md sections 3.3 and 8.4. At most
-- one Default source per seller. Invisible to Prisma; checked by the partial-index catalog test.
CREATE UNIQUE INDEX "sources_market_id_seller_id_default_key" ON "inventory"."sources" ("market_id", "seller_id") WHERE "is_default";

-- Grants (database-designer): docs/design/data/inventory.md section 7. The outbox, the stock and
-- the reservations arrive with their slices; DELETE arrives with the prune job for the inbox.
GRANT USAGE ON SCHEMA "inventory" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "inventory"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("low_stock_threshold", "version") ON TABLE "inventory"."seller_inventories" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("name", "address", "time_zone", "priority") ON TABLE "inventory"."sources" TO "mondapac_app";
