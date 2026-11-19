-- Per-sell-unit SKU and the reversible "selling" switch (variants V5; plan decisions t4, t14).
-- Creates catalog.offer_sell_units, one sparse row per (Offer, Variant); no row means selling
-- with no variant SKU, so nothing is backfilled. Safety: a blocked statement fails instead of
-- queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."offer_sell_units" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "variant_sku" TEXT COLLATE "C",
    "selling" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_sell_units_pkey" PRIMARY KEY ("market_id","offer_id","variant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offer_sell_units_market_id_id_key" ON "catalog"."offer_sell_units"("market_id", "id");

-- CreateIndex
CREATE INDEX "offer_sell_units_market_id_seller_id_idx" ON "catalog"."offer_sell_units"("market_id", "seller_id");

-- Hand-written: shape of the SKU (the same as an Offer's), the version, the instants.
ALTER TABLE "catalog"."offer_sell_units"
  ADD CONSTRAINT "offer_sell_units_variant_sku_check" CHECK ("variant_sku" IS NULL OR "variant_sku" ~ '^[!-~]{1,64}$'),
  ADD CONSTRAINT "offer_sell_units_version_check" CHECK ("version" >= 1);

-- A variant SKU is unique per seller across all their sell units (an Offer that is deleted keeps
-- its rows, so its SKUs stay taken; the seller clears them first).
CREATE UNIQUE INDEX "offer_sell_units_market_id_seller_id_variant_sku_key"
  ON "catalog"."offer_sell_units" ("market_id", "seller_id", "variant_sku") WHERE "variant_sku" IS NOT NULL;

-- The row belongs to an Offer of the same seller and to a variant of the stated product (the
-- application writes the Offer's product; the Offer-move slice (CAT-45) must re-key it, 2.4).
ALTER TABLE "catalog"."offer_sell_units"
  ADD CONSTRAINT "offer_sell_units_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id")
    REFERENCES "catalog"."offers" ("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "offer_sell_units_market_id_product_id_variant_id_fkey" FOREIGN KEY ("market_id", "product_id", "variant_id")
    REFERENCES "catalog"."product_variants" ("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A variant SKU never equals an open Offer's SKU of the same seller, in either direction. The
-- partial unique cannot span two tables, so two triggers decide a race (each locks the seller's
-- key space through an advisory lock held to commit).
CREATE FUNCTION "catalog"."offer_sell_units_sku_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.variant_sku IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.market_id || ':' || NEW.seller_id::text || ':sku', 0));
    IF EXISTS (SELECT 1 FROM "catalog"."offers" o
                WHERE o.market_id = NEW.market_id AND o.seller_id = NEW.seller_id
                  AND o.seller_sku = NEW.variant_sku AND o.status <> 'deleted') THEN
      RAISE EXCEPTION 'catalog.offer_sell_units: the variant SKU equals an Offer SKU of the seller'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'offer_sell_units_vs_offer_sku';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_sell_units_sku_guard_insert" BEFORE INSERT
  ON "catalog"."offer_sell_units" FOR EACH ROW WHEN (NEW."variant_sku" IS NOT NULL)
  EXECUTE FUNCTION "catalog"."offer_sell_units_sku_guard"();
CREATE TRIGGER "offer_sell_units_sku_guard_update" BEFORE UPDATE OF "variant_sku"
  ON "catalog"."offer_sell_units" FOR EACH ROW WHEN (NEW."variant_sku" IS NOT NULL AND NEW."variant_sku" IS DISTINCT FROM OLD."variant_sku")
  EXECUTE FUNCTION "catalog"."offer_sell_units_sku_guard"();

CREATE FUNCTION "catalog"."offers_vs_unit_sku_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'deleted' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.market_id || ':' || NEW.seller_id::text || ':sku', 0));
    IF EXISTS (SELECT 1 FROM "catalog"."offer_sell_units" u
                WHERE u.market_id = NEW.market_id AND u.seller_id = NEW.seller_id
                  AND u.variant_sku = NEW.seller_sku) THEN
      RAISE EXCEPTION 'catalog.offers: the SKU equals a variant SKU of the seller'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'offers_vs_unit_sku';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
-- The Offer triggers fire only when the SKU or the status really changes, so an ordinary Offer save
-- takes no seller-wide lock.
CREATE TRIGGER "offers_vs_unit_sku_guard_insert" BEFORE INSERT
  ON "catalog"."offers" FOR EACH ROW EXECUTE FUNCTION "catalog"."offers_vs_unit_sku_guard"();
CREATE TRIGGER "offers_vs_unit_sku_guard_update" BEFORE UPDATE OF "seller_sku", "status"
  ON "catalog"."offers" FOR EACH ROW
  WHEN (NEW."seller_sku" IS DISTINCT FROM OLD."seller_sku" OR NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION "catalog"."offers_vs_unit_sku_guard"();

-- Grants: the application inserts and updates the switch and the SKU; nothing else changes and no
-- row is ever deleted (no DELETE grant).
GRANT SELECT, INSERT ON TABLE "catalog"."offer_sell_units" TO "mondapac_app";
GRANT UPDATE ("variant_sku", "selling", "version", "updated_at") ON TABLE "catalog"."offer_sell_units" TO "mondapac_app";
