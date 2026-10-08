-- Safety (docs/design/data/inventory.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "inventory"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_items" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_movements" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "resulting_on_hand" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "actor_module" TEXT,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."availability_signals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "only_left" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "availability_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."retirements" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID,
    "source_aggregate_version" INTEGER NOT NULL,
    "retired_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "retirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "inventory"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "stock_items_market_id_seller_id_offer_id_idx" ON "inventory"."stock_items"("market_id", "seller_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_market_id_offer_id_variant_id_source_id_key" ON "inventory"."stock_items"("market_id", "offer_id", "variant_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_market_id_id_offer_id_variant_id_key" ON "inventory"."stock_items"("market_id", "id", "offer_id", "variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_market_id_stock_item_id_occurred_at_id_idx" ON "inventory"."stock_movements"("market_id", "stock_item_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "availability_signals_market_id_offer_id_variant_id_key" ON "inventory"."availability_signals"("market_id", "offer_id", "variant_id");

-- AddForeignKey
ALTER TABLE "inventory"."stock_items" ADD CONSTRAINT "stock_items_market_id_source_id_seller_id_fkey" FOREIGN KEY ("market_id", "source_id", "seller_id") REFERENCES "inventory"."sources"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_market_id_stock_item_id_offer_id_variant_i_fkey" FOREIGN KEY ("market_id", "stock_item_id", "offer_id", "variant_id") REFERENCES "inventory"."stock_items"("market_id", "id", "offer_id", "variant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/inventory.md sections 2 (C1, C5, C6), 3.1,
-- 3.4, 3.5, 3.9 and 3.10. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "inventory"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^inventory\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "inventory"."stock_items"
  ADD CONSTRAINT "stock_items_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "stock_items_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "stock_items_on_hand_check" CHECK ("on_hand" >= 0),
  ADD CONSTRAINT "stock_items_version_check" CHECK ("version" >= 1);

ALTER TABLE "inventory"."stock_movements"
  ADD CONSTRAINT "stock_movements_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "stock_movements_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "stock_movements_delta_check" CHECK ("delta" <> 0),
  ADD CONSTRAINT "stock_movements_resulting_on_hand_check" CHECK (
    "resulting_on_hand" >= 0 AND "resulting_on_hand" - "delta" >= 0),
  ADD CONSTRAINT "stock_movements_reason_check" CHECK (
    "reason" IN ('seller-set', 'shipment', 'restock', 're-key')),
  ADD CONSTRAINT "stock_movements_actor_kind_check" CHECK ("actor_kind" IN ('account', 'module')),
  ADD CONSTRAINT "stock_movements_actor_account_id_check" CHECK (
    ("actor_kind" = 'account') = ("actor_account_id" IS NOT NULL)),
  ADD CONSTRAINT "stock_movements_actor_module_check" CHECK (
    ("actor_module" IS NULL OR "actor_module" ~ '^[a-z][a-z0-9-]*$')
    AND ("actor_kind" = 'module') = ("actor_module" IS NOT NULL)),
  ADD CONSTRAINT "stock_movements_correlation_id_check" CHECK (
    "correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "stock_movements_system_reason_check" CHECK (
    "reason" NOT IN ('shipment', 're-key') OR "actor_kind" = 'module');

ALTER TABLE "inventory"."availability_signals"
  ADD CONSTRAINT "availability_signals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "availability_signals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "availability_signals_status_check" CHECK ("status" IN ('in-stock', 'low', 'out')),
  ADD CONSTRAINT "availability_signals_only_left_check" CHECK (
    ("status" = 'low') = ("only_left" IS NOT NULL)
    AND ("only_left" IS NULL OR "only_left" BETWEEN 1 AND 99)),
  ADD CONSTRAINT "availability_signals_version_check" CHECK ("version" >= 1);

ALTER TABLE "inventory"."retirements"
  ADD CONSTRAINT "retirements_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "retirements_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "retirements_scope_check" CHECK ("scope" IN ('offer', 'variant')),
  ADD CONSTRAINT "retirements_variant_id_check" CHECK (("scope" = 'variant') = ("variant_id" IS NOT NULL)),
  ADD CONSTRAINT "retirements_source_aggregate_version_check" CHECK ("source_aggregate_version" >= 1);

-- Hand-written (database-designer): docs/design/data/inventory.md section 8.4. Invisible to
-- Prisma; checked by the partial-index catalog test. The relay's claim, and one tombstone per
-- Offer and per Variant (Prisma cannot declare NULLS NOT DISTINCT).
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "inventory"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE UNIQUE INDEX "retirements_market_id_offer_id_offer_key" ON "inventory"."retirements" ("market_id", "offer_id") WHERE "scope" = 'offer';
CREATE UNIQUE INDEX "retirements_market_id_offer_id_variant_id_variant_key" ON "inventory"."retirements" ("market_id", "offer_id", "variant_id") WHERE "scope" = 'variant';

-- Grants (database-designer): docs/design/data/inventory.md section 7. The ledger is append-only
-- by privilege; a tombstone is inserted or cleared, never edited; stock items are retired,
-- never deleted. The reservations arrive with their slice.
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "inventory"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("on_hand", "retired_at", "version") ON TABLE "inventory"."stock_items" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "inventory"."stock_movements" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "only_left", "changed_at", "version") ON TABLE "inventory"."availability_signals" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "inventory"."retirements" TO "mondapac_app";
