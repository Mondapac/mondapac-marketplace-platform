-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sellers";

-- CreateTable
CREATE TABLE "sellers"."outbox" (
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
CREATE TABLE "sellers"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "sellers"."seller_files" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "approval_required_at_registration" BOOLEAN NOT NULL,
    "draft_complete" BOOLEAN NOT NULL,
    "last_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_files_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "sellers"."seller_admin_settings" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "all_product_types_allowed" BOOLEAN NOT NULL,
    "all_product_types_changed_at" TIMESTAMPTZ(6),
    "all_product_types_changed_by_account_id" UUID,
    "category_proposals_allowed" BOOLEAN NOT NULL,
    "category_proposals_changed_at" TIMESTAMPTZ(6),
    "category_proposals_changed_by_account_id" UUID,
    "ai_enabled" BOOLEAN NOT NULL,
    "ai_enabled_changed_at" TIMESTAMPTZ(6),
    "ai_enabled_changed_by_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_admin_settings_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "sellers"."seller_tax_profiles" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_tax_profiles_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "sellers"."store_profiles" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_profiles_pkey" PRIMARY KEY ("seller_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "sellers"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "seller_files_market_id_seller_id_key" ON "sellers"."seller_files"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_admin_settings_market_id_seller_id_key" ON "sellers"."seller_admin_settings"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_tax_profiles_market_id_seller_id_key" ON "sellers"."seller_tax_profiles"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_profiles_market_id_seller_id_key" ON "sellers"."store_profiles"("market_id", "seller_id");

-- AddForeignKey
ALTER TABLE "sellers"."seller_admin_settings" ADD CONSTRAINT "seller_admin_settings_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."seller_tax_profiles" ADD CONSTRAINT "seller_tax_profiles_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."store_profiles" ADD CONSTRAINT "store_profiles_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/sellers.md sections 2 (C1, S1), 3.1, 3.7,
-- 3.8, 3.9 and 3.12. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "sellers"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^sellers\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "sellers"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^sellers\.[a-z0-9-]+$');

ALTER TABLE "sellers"."seller_files"
  ADD CONSTRAINT "seller_files_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_files_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_files_origin_check" CHECK ("origin" IN ('self', 'invitation')),
  ADD CONSTRAINT "seller_files_last_changed_at_check" CHECK ("last_changed_at" >= "created_at"),
  ADD CONSTRAINT "seller_files_version_check" CHECK ("version" >= 1);

ALTER TABLE "sellers"."seller_admin_settings"
  ADD CONSTRAINT "seller_admin_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_admin_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_admin_settings_all_product_types_changed_check" CHECK (
    ("all_product_types_changed_at" IS NULL) = ("all_product_types_changed_by_account_id" IS NULL)),
  ADD CONSTRAINT "seller_admin_settings_category_proposals_changed_check" CHECK (
    ("category_proposals_changed_at" IS NULL) = ("category_proposals_changed_by_account_id" IS NULL)),
  ADD CONSTRAINT "seller_admin_settings_ai_enabled_changed_check" CHECK (
    ("ai_enabled_changed_at" IS NULL) = ("ai_enabled_changed_by_account_id" IS NULL)),
  ADD CONSTRAINT "seller_admin_settings_version_check" CHECK ("version" >= 1);

ALTER TABLE "sellers"."seller_tax_profiles"
  ADD CONSTRAINT "seller_tax_profiles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_tax_profiles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_tax_profiles_version_check" CHECK ("version" >= 1);

ALTER TABLE "sellers"."store_profiles"
  ADD CONSTRAINT "store_profiles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_profiles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "store_profiles_version_check" CHECK ("version" >= 1);

-- Hand-written (database-designer): docs/design/data/sellers.md section 9.5, the relay's claim
-- (platform persistence design 6.1). Invisible to Prisma; checked by the partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "sellers"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants (database-designer): docs/design/data/sellers.md section 8. DELETE arrives with the
-- slice that first deletes from a table (18 for the four roots; the prune job for the inbox).
GRANT USAGE ON SCHEMA "sellers" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "sellers"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "sellers"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_files" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_admin_settings" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_tax_profiles" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."store_profiles" TO "mondapac_app";
