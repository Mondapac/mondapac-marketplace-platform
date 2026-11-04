-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "promotions"."promotions" ADD COLUMN     "buy_qty" SMALLINT,
ADD COLUMN     "flash_time_zone" TEXT,
ADD COLUMN     "flash_unit_limit" INTEGER,
ADD COLUMN     "get_qty" SMALLINT,
ADD COLUMN     "group_qty" SMALLINT,
ADD COLUMN     "max_repeats_per_order" SMALLINT;

-- CreateTable
CREATE TABLE "promotions"."promotion_tiers" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "threshold_minor" BIGINT NOT NULL,
    "reward_kind" TEXT NOT NULL,
    "reward_bps" INTEGER,
    "reward_amount_minor" BIGINT,

    CONSTRAINT "promotion_tiers_pkey" PRIMARY KEY ("market_id","promotion_id","threshold_minor")
);

-- CreateTable
CREATE TABLE "promotions"."promotion_bundle_items" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" SMALLINT NOT NULL,

    CONSTRAINT "promotion_bundle_items_pkey" PRIMARY KEY ("market_id","promotion_id","product_id")
);

-- CreateTable
CREATE TABLE "promotions"."promotion_batch_codes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "promotion_batch_codes_pkey" PRIMARY KEY ("market_id","code_hash")
);

-- CreateIndex
CREATE INDEX "promotion_batch_codes_market_id_promotion_id_idx" ON "promotions"."promotion_batch_codes"("market_id", "promotion_id");

-- AddForeignKey
ALTER TABLE "promotions"."promotion_tiers" ADD CONSTRAINT "promotion_tiers_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."promotion_bundle_items" ADD CONSTRAINT "promotion_bundle_items_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."promotion_batch_codes" ADD CONSTRAINT "promotion_batch_codes_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the CHECKs of the new columns and tables, the wider type lists, the never-deleted
-- trigger of the codes and the grants. The merged core migration is not edited: its two type
-- CHECKs are replaced here.
ALTER TABLE "promotions"."promotions"
  DROP CONSTRAINT "promotions_type_check",
  DROP CONSTRAINT "promotions_type_funding_check";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_check" CHECK ("type" IN ('SELLER_SALE', 'CART_DISCOUNT', 'CART_CODE', 'FREE_SHIPPING', 'CO_FUNDED_CAMPAIGN', 'TIERED_CART', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'FLASH_SALE', 'BATCH_CODE')),
  -- Who pays: a co-funded campaign is co-funded and nothing else is; a seller's own offers are
  -- seller-funded; shipping, tiered carts and batch codes are the platform's. A flash sale is
  -- either one's, never co-funded.
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE') OR "funding" = 'PLATFORM')),
  -- The parameters of a type are set for that type only. A multi-buy's reward is FIXED (the price
  -- of one group) and so is a bundle's (the amount off one set).
  ADD CONSTRAINT "promotions_params_check" CHECK (
    CASE "type"
      WHEN 'BUY_X_GET_Y' THEN
        COALESCE("buy_qty" BETWEEN 1 AND 1000, false) AND COALESCE("get_qty" BETWEEN 1 AND 1000, false)
        AND "group_qty" IS NULL
      WHEN 'MULTI_BUY' THEN
        COALESCE("group_qty" BETWEEN 2 AND 1000, false) AND "buy_qty" IS NULL AND "get_qty" IS NULL
        AND "reward_kind" = 'FIXED'
      WHEN 'BUNDLE' THEN
        "buy_qty" IS NULL AND "get_qty" IS NULL AND "group_qty" IS NULL AND "reward_kind" = 'FIXED'
      ELSE "buy_qty" IS NULL AND "get_qty" IS NULL AND "group_qty" IS NULL
    END
    AND ("max_repeats_per_order" IS NULL
      OR ("type" IN ('BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE') AND "max_repeats_per_order" BETWEEN 1 AND 1000))),
  -- A flash sale has a limit of units, the zone its window was written in and a real end.
  ADD CONSTRAINT "promotions_flash_check" CHECK (
    CASE "type"
      WHEN 'FLASH_SALE' THEN
        COALESCE("flash_unit_limit" >= 1, false) AND COALESCE(char_length("flash_time_zone") BETWEEN 1 AND 64, false)
        AND "ends_at" IS NOT NULL
      ELSE "flash_unit_limit" IS NULL AND "flash_time_zone" IS NULL
    END);

ALTER TABLE "promotions"."promotion_tiers"
  ADD CONSTRAINT "promotion_tiers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_tiers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_tiers_threshold_check" CHECK ("threshold_minor" >= 1),
  ADD CONSTRAINT "promotion_tiers_reward_check" CHECK (
    CASE "reward_kind"
      WHEN 'PERCENT' THEN COALESCE("reward_bps" BETWEEN 1 AND 10000, false) AND "reward_amount_minor" IS NULL
      WHEN 'FIXED' THEN COALESCE("reward_amount_minor" >= 1, false) AND "reward_bps" IS NULL
      ELSE false
    END);

ALTER TABLE "promotions"."promotion_bundle_items"
  ADD CONSTRAINT "promotion_bundle_items_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_bundle_items_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_bundle_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 1000);

ALTER TABLE "promotions"."promotion_batch_codes"
  ADD CONSTRAINT "promotion_batch_codes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_batch_codes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_batch_codes_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "promotion_batch_codes_used_check" CHECK ("used_at" IS NULL OR "used_at" >= "created_at");

-- A generated code is never deleted or truncated, whoever asks (it is used, or it stays).
CREATE TRIGGER "promotion_batch_codes_no_delete" BEFORE DELETE ON "promotions"."promotion_batch_codes"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotion_batch_codes_no_truncate" BEFORE TRUNCATE ON "promotions"."promotion_batch_codes"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();

-- Grants. The new parameters of a promotion are editable like its reward; the tiers and the bundle
-- items are replaced as a set (so DELETE); the codes are insert-only here (package T2 adds the
-- UPDATE of "used_at" when an order redeems one).
GRANT UPDATE ("buy_qty", "flash_time_zone", "flash_unit_limit", "get_qty", "group_qty", "max_repeats_per_order") ON TABLE "promotions"."promotions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_tiers" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_bundle_items" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "promotions"."promotion_batch_codes" TO "mondapac_app";
