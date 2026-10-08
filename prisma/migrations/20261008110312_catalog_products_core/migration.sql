-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "catalog";

-- CreateTable
CREATE TABLE "catalog"."outbox" (
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
CREATE TABLE "catalog"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "catalog"."products" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "owner_seller_id" UUID,
    "created_by_seller_id" UUID,
    "type_code" TEXT NOT NULL,
    "variant_model" TEXT NOT NULL,
    "family_code" TEXT NOT NULL,
    "product_code" TEXT COLLATE "C" NOT NULL,
    "status" TEXT NOT NULL,
    "discarded_at" TIMESTAMPTZ(6),
    "own_brand" BOOLEAN NOT NULL,
    "matched_into_product_id" UUID,
    "promoted_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "last_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."product_variants" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_model" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."product_code_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL,

    CONSTRAINT "product_code_counters_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "catalog"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "products_market_id_id_key" ON "catalog"."products"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_market_id_id_variant_model_key" ON "catalog"."products"("market_id", "id", "variant_model");

-- CreateIndex
CREATE UNIQUE INDEX "products_market_id_product_code_key" ON "catalog"."products"("market_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_market_id_id_key" ON "catalog"."product_variants"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_market_id_product_id_id_key" ON "catalog"."product_variants"("market_id", "product_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_market_id_matched_into_product_id_fkey" FOREIGN KEY ("market_id", "matched_into_product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey" FOREIGN KEY ("market_id", "product_id", "variant_model") REFERENCES "catalog"."products"("market_id", "id", "variant_model") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/catalog.md sections 2 (CA3, CA4, CA7),
-- 3.1, 3.2, 3.3 and 3.26. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "catalog"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^catalog\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "catalog"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^catalog\.[a-z0-9-]+$');

ALTER TABLE "catalog"."products"
  ADD CONSTRAINT "products_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "products_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "products_scope_check" CHECK ("scope" IN ('PLATFORM', 'SELLER')),
  ADD CONSTRAINT "products_owner_check" CHECK (("scope" = 'SELLER') = ("owner_seller_id" IS NOT NULL)),
  ADD CONSTRAINT "products_type_code_check" CHECK ("type_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "products_variant_model_check" CHECK ("variant_model" IN ('single', 'options')),
  ADD CONSTRAINT "products_family_code_check" CHECK ("family_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "products_product_code_check" CHECK ("product_code" ~ '^[A-Z0-9][A-Z0-9-]{3,31}$'),
  ADD CONSTRAINT "products_status_check" CHECK ("status" IN
    ('draft', 'discarded', 'unpublished', 'published', 'matched', 'withdrawn', 'retired')),
  ADD CONSTRAINT "products_discarded_check" CHECK (("status" = 'discarded') = ("discarded_at" IS NOT NULL)),
  ADD CONSTRAINT "products_matched_check" CHECK (("status" = 'matched') = ("matched_into_product_id" IS NOT NULL)),
  ADD CONSTRAINT "products_matched_not_self_check" CHECK ("matched_into_product_id" <> "id"),
  ADD CONSTRAINT "products_retired_check" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "products_withdrawn_check" CHECK (("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)),
  ADD CONSTRAINT "products_promoted_check" CHECK ("promoted_at" IS NULL OR "scope" = 'PLATFORM'),
  ADD CONSTRAINT "products_last_changed_at_check" CHECK ("last_changed_at" >= "created_at"),
  ADD CONSTRAINT "products_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."product_variants"
  ADD CONSTRAINT "product_variants_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_variants_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_variants_variant_model_check" CHECK ("variant_model" IN ('single', 'options')),
  ADD CONSTRAINT "product_variants_state_check" CHECK ("state" IN ('proposed', 'published', 'retired')),
  ADD CONSTRAINT "product_variants_retired_check" CHECK (("state" = 'retired') = ("retired_at" IS NOT NULL)),
  ADD CONSTRAINT "product_variants_published_check" CHECK (
    "state" = 'proposed' OR "published_at" IS NOT NULL OR "state" = 'retired'),
  -- CA7: variant ids are minted by the server as UUIDv7; a client-made v4 id fails here.
  ADD CONSTRAINT "product_variants_id_v7_check" CHECK (substring("id"::text, 15, 1) = '7');

ALTER TABLE "catalog"."product_code_counters"
  ADD CONSTRAINT "product_code_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_code_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_code_counters_next_value_check" CHECK ("next_value" >= 1);

-- Hand-written (database-designer): data design 3.2, exactly one variant row for a Simple
-- product, and 3.26, the relay's claim (platform persistence design 6.1). Invisible to Prisma;
-- checked by the partial-index catalog test.
CREATE UNIQUE INDEX "product_variants_market_id_product_id_single_key"
  ON "catalog"."product_variants" ("market_id", "product_id") WHERE "variant_model" = 'single';
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "catalog"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Hand-written (database-designer): data design 5.1. Every catalog function is SECURITY INVOKER,
-- pins search_path, schema-qualifies every name and uses no dynamic EXECUTE (Q-K8). The function
-- reject_mutation() serves the insert-only tables of later slices; it has no user yet.
CREATE FUNCTION "catalog"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'catalog.%: append-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

-- Data design 3.2 (M-1, Q-K15): a variant id is never reused or revived, never deleted, and its
-- identity columns never change. A Simple product's single variant is retired only together
-- with its discarded product (the discard unit updates the product first).
CREATE FUNCTION "catalog"."product_variants_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.product_variants: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.product_id, NEW.variant_model, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.product_id, OLD.variant_model, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.product_variants: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'retired' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'catalog.product_variants: a retired variant never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.state = NEW.state
          OR (OLD.state = 'proposed' AND NEW.state IN ('published', 'retired'))
          OR (OLD.state = 'published' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION 'catalog.product_variants: transition % to % is not allowed', OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = 'retired' AND OLD.state <> 'retired' AND NEW.variant_model = 'single' THEN
    SELECT p.status INTO p_status FROM "catalog"."products" p
     WHERE p.market_id = NEW.market_id AND p.id = NEW.product_id;
    IF p_status IS DISTINCT FROM 'discarded' THEN
      RAISE EXCEPTION 'catalog.product_variants: a single variant is retired only with a discarded product'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "product_variants_guard" BEFORE UPDATE OR DELETE ON "catalog"."product_variants"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."product_variants_guard"();

-- Grants (database-designer): docs/design/data/catalog.md section 7. No DELETE anywhere (Q-K2):
-- a discarded draft keeps its product row, and its variants are retired.
GRANT USAGE ON SCHEMA "catalog" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "catalog"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("scope", "owner_seller_id", "status", "discarded_at", "own_brand",
  "matched_into_product_id", "promoted_at", "retired_at", "withdrawn_at", "last_changed_at", "version")
  ON TABLE "catalog"."products" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "published_at", "retired_at")
  ON TABLE "catalog"."product_variants" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("next_value") ON TABLE "catalog"."product_code_counters" TO "mondapac_app";
