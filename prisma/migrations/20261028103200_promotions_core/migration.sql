-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "promotions";

-- CreateTable
CREATE TABLE "promotions"."promotions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "funding" TEXT NOT NULL,
    "platform_split_bps" SMALLINT,
    "owner_seller_id" UUID,
    "combinable" BOOLEAN NOT NULL,
    "code" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "test_mode" BOOLEAN NOT NULL,
    "special_campaign" BOOLEAN NOT NULL,
    "prior_approved" BOOLEAN NOT NULL,
    "paused_by" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "reward_kind" TEXT NOT NULL,
    "reward_bps" INTEGER,
    "reward_amount_minor" BIGINT,
    "cap_minor" BIGINT,
    "max_per_order_minor" BIGINT,
    "max_total_uses" INTEGER,
    "max_uses_per_customer" INTEGER,
    "budget_minor" BIGINT,
    "min_spend_minor" BIGINT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions"."promotion_targets" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("market_id","promotion_id","kind","value")
);

-- CreateTable
CREATE TABLE "promotions"."promotion_usage" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "uses_count" INTEGER NOT NULL,
    "spent_minor" BIGINT NOT NULL,
    "seller_share_minor" BIGINT NOT NULL,
    "platform_share_minor" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotion_usage_pkey" PRIMARY KEY ("market_id","promotion_id")
);

-- CreateTable
CREATE TABLE "promotions"."co_funding_opt_ins" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "opted_in_at" TIMESTAMPTZ(6) NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID NOT NULL,

    CONSTRAINT "co_funding_opt_ins_pkey" PRIMARY KEY ("market_id","promotion_id","seller_id")
);

-- CreateTable
CREATE TABLE "promotions"."promotion_reviews" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,

    CONSTRAINT "promotion_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions"."first_order_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "percent_bps" INTEGER,
    "amount_minor" BIGINT,
    "cap_minor" BIGINT,
    "min_spend_minor" BIGINT NOT NULL,
    "monthly_budget_minor" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "first_order_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateTable
CREATE TABLE "promotions"."free_shipping_thresholds" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "zone_code" TEXT NOT NULL,
    "threshold_minor" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "free_shipping_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions"."market_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE INDEX "promotions_market_id_status_starts_at_idx" ON "promotions"."promotions"("market_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "promotions_market_id_owner_seller_id_created_at_idx" ON "promotions"."promotions"("market_id", "owner_seller_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_market_id_id_key" ON "promotions"."promotions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_market_id_code_key" ON "promotions"."promotions"("market_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "free_shipping_thresholds_market_id_zone_code_key" ON "promotions"."free_shipping_thresholds"("market_id", "zone_code");

-- CreateIndex
CREATE INDEX "promotion_reviews_market_id_status_opened_at_idx" ON "promotions"."promotion_reviews"("market_id", "status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_reviews_market_id_id_key" ON "promotions"."promotion_reviews"("market_id", "id");

-- AddForeignKey
ALTER TABLE "promotions"."promotion_targets" ADD CONSTRAINT "promotion_targets_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."promotion_usage" ADD CONSTRAINT "promotion_usage_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."co_funding_opt_ins" ADD CONSTRAINT "co_funding_opt_ins_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."promotion_reviews" ADD CONSTRAINT "promotion_reviews_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs, the open-review unique index, the never-deleted triggers and the grants.
-- The ids of a Market and a tenant have a fixed shape on every table.
ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotions_type_check" CHECK ("type" IN ('SELLER_SALE', 'CART_DISCOUNT', 'CART_CODE', 'FREE_SHIPPING', 'CO_FUNDED_CAMPAIGN')),
  ADD CONSTRAINT "promotions_status_check" CHECK ("status" IN ('PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REJECTED')),
  ADD CONSTRAINT "promotions_funding_check" CHECK ("funding" IN ('SELLER', 'PLATFORM', 'CO_FUNDED')),
  ADD CONSTRAINT "promotions_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  ADD CONSTRAINT "promotions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- A split exists if and only if the promotion is co-funded.
  ADD CONSTRAINT "promotions_split_check" CHECK (
    ("funding" = 'CO_FUNDED') = ("platform_split_bps" IS NOT NULL)
    AND ("platform_split_bps" IS NULL OR "platform_split_bps" BETWEEN 1 AND 9999)),
  -- A seller owns exactly the seller-funded promotions; the platform owns the rest.
  ADD CONSTRAINT "promotions_owner_check" CHECK (("funding" = 'SELLER') = ("owner_seller_id" IS NOT NULL)),
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" <> 'SELLER_SALE' OR "funding" = 'SELLER')
    AND ("type" <> 'FREE_SHIPPING' OR "funding" = 'PLATFORM')),
  ADD CONSTRAINT "promotions_code_check" CHECK (
    ("type" = 'CART_CODE') = ("code" IS NOT NULL)
    AND ("code" IS NULL OR "code" ~ '^[A-Z0-9][A-Z0-9-]{3,31}$')),
  ADD CONSTRAINT "promotions_schedule_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  ADD CONSTRAINT "promotions_reward_check" CHECK (
    CASE "reward_kind"
      WHEN 'PERCENT' THEN COALESCE("reward_bps" BETWEEN 1 AND 10000, false) AND "reward_amount_minor" IS NULL
      WHEN 'FIXED' THEN COALESCE("reward_amount_minor" >= 1, false) AND "reward_bps" IS NULL
      ELSE false
    END),
  ADD CONSTRAINT "promotions_limits_check" CHECK (
    ("cap_minor" IS NULL OR "cap_minor" >= 1)
    AND ("max_per_order_minor" IS NULL OR "max_per_order_minor" >= 1)
    AND ("max_total_uses" IS NULL OR "max_total_uses" >= 1)
    AND ("max_uses_per_customer" IS NULL OR "max_uses_per_customer" >= 1)
    AND ("budget_minor" IS NULL OR "budget_minor" >= 1)
    AND ("min_spend_minor" IS NULL OR "min_spend_minor" >= 0)),
  -- Every platform-funded or co-funded promotion has a total budget.
  ADD CONSTRAINT "promotions_budget_check" CHECK ("funding" = 'SELLER' OR "budget_minor" IS NOT NULL),
  ADD CONSTRAINT "promotions_special_check" CHECK (NOT "special_campaign" OR "funding" <> 'SELLER'),
  ADD CONSTRAINT "promotions_paused_by_check" CHECK (
    ("status" = 'PAUSED') = ("paused_by" IS NOT NULL)
    AND ("paused_by" IS NULL OR "paused_by" IN ('ADMIN', 'SELLER'))),
  -- Only a seller's promotion waits for approval or is rejected.
  ADD CONSTRAINT "promotions_review_status_check" CHECK (
    "status" NOT IN ('PENDING_APPROVAL', 'REJECTED') OR "owner_seller_id" IS NOT NULL);

ALTER TABLE "promotions"."promotion_targets"
  ADD CONSTRAINT "promotion_targets_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_targets_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_targets_kind_check" CHECK ("kind" IN ('PRODUCT', 'SELLER', 'ZONE')),
  ADD CONSTRAINT "promotion_targets_value_check" CHECK (
    CASE "kind"
      WHEN 'ZONE' THEN "value" ~ '^[A-Za-z0-9_-]{1,64}$'
      ELSE "value" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    END);

ALTER TABLE "promotions"."promotion_usage"
  ADD CONSTRAINT "promotion_usage_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_usage_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_usage_counts_check" CHECK (
    "uses_count" >= 0 AND "spent_minor" >= 0 AND "seller_share_minor" >= 0 AND "platform_share_minor" >= 0
    AND "seller_share_minor" + "platform_share_minor" = "spent_minor");

ALTER TABLE "promotions"."co_funding_opt_ins"
  ADD CONSTRAINT "co_funding_opt_ins_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "co_funding_opt_ins_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "co_funding_opt_ins_withdrawn_check" CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" >= "opted_in_at");

ALTER TABLE "promotions"."promotion_reviews"
  ADD CONSTRAINT "promotion_reviews_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "promotion_reviews_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "promotion_reviews_reason_check" CHECK ("reason" IN ('NEW_SELLER', 'HIGH_DISCOUNT', 'POST_REVIEW')),
  ADD CONSTRAINT "promotion_reviews_status_check" CHECK ("status" IN ('OPEN', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT "promotion_reviews_decision_check" CHECK (
    ("status" = 'OPEN') = ("decided_at" IS NULL)
    AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL));

ALTER TABLE "promotions"."first_order_settings"
  ADD CONSTRAINT "first_order_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "first_order_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "first_order_settings_reward_check" CHECK (
    CASE "kind"
      WHEN 'PERCENT' THEN COALESCE("percent_bps" BETWEEN 1 AND 10000, false) AND "amount_minor" IS NULL
      WHEN 'FIXED' THEN COALESCE("amount_minor" >= 1, false) AND "percent_bps" IS NULL
      ELSE false
    END),
  ADD CONSTRAINT "first_order_settings_amounts_check" CHECK (
    ("cap_minor" IS NULL OR "cap_minor" >= 1) AND "min_spend_minor" >= 0 AND "monthly_budget_minor" >= 0);

ALTER TABLE "promotions"."free_shipping_thresholds"
  ADD CONSTRAINT "free_shipping_thresholds_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "free_shipping_thresholds_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "free_shipping_thresholds_zone_check" CHECK ("zone_code" ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD CONSTRAINT "free_shipping_thresholds_amount_check" CHECK ("threshold_minor" >= 1);

ALTER TABLE "promotions"."market_settings"
  ADD CONSTRAINT "market_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "market_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "market_settings_status_check" CHECK ("status" IN ('off', 'active'));

-- Hand-written partial unique index (Prisma cannot declare it): at most one open review entry per
-- promotion.
CREATE UNIQUE INDEX "promotion_reviews_one_open_idx" ON "promotions"."promotion_reviews" ("market_id", "promotion_id") WHERE "status" = 'OPEN';

-- Hand-written: these tables are never deleted from or truncated, whoever asks (a promotion ends
-- or is paused; a review is decided; a setting is changed). The targets are replaced as a set and
-- a free-shipping threshold can return to the Market default, so those two allow DELETE.
CREATE FUNCTION "promotions"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'promotions.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "promotions_no_delete" BEFORE DELETE ON "promotions"."promotions"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotions_no_truncate" BEFORE TRUNCATE ON "promotions"."promotions"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotion_usage_no_delete" BEFORE DELETE ON "promotions"."promotion_usage"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotion_usage_no_truncate" BEFORE TRUNCATE ON "promotions"."promotion_usage"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "co_funding_opt_ins_no_delete" BEFORE DELETE ON "promotions"."co_funding_opt_ins"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "co_funding_opt_ins_no_truncate" BEFORE TRUNCATE ON "promotions"."co_funding_opt_ins"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotion_reviews_no_delete" BEFORE DELETE ON "promotions"."promotion_reviews"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "promotion_reviews_no_truncate" BEFORE TRUNCATE ON "promotions"."promotion_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "first_order_settings_no_delete" BEFORE DELETE ON "promotions"."first_order_settings"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "first_order_settings_no_truncate" BEFORE TRUNCATE ON "promotions"."first_order_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "market_settings_no_delete" BEFORE DELETE ON "promotions"."market_settings"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "market_settings_no_truncate" BEFORE TRUNCATE ON "promotions"."market_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();

-- Grants. The type, funding, owner, code and currency of a promotion never change, so they are not
-- among the updatable columns; neither are the Market, tenant and ids of any row. The usage
-- counters are read here and written by package T2 (its migration adds the UPDATE grant).
GRANT USAGE ON SCHEMA "promotions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("budget_minor", "cap_minor", "combinable", "ends_at", "max_per_order_minor", "max_total_uses", "max_uses_per_customer", "min_spend_minor", "name", "paused_by", "platform_split_bps", "prior_approved", "reward_amount_minor", "reward_bps", "reward_kind", "special_campaign", "starts_at", "status", "test_mode", "updated_at") ON TABLE "promotions"."promotions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_targets" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "promotions"."promotion_usage" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("decided_by_account_id", "opted_in_at", "withdrawn_at") ON TABLE "promotions"."co_funding_opt_ins" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("decided_at", "decided_by_account_id", "opened_at", "reason", "status") ON TABLE "promotions"."promotion_reviews" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("amount_minor", "cap_minor", "enabled", "kind", "min_spend_minor", "monthly_budget_minor", "percent_bps", "updated_at", "updated_by_account_id") ON TABLE "promotions"."first_order_settings" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("threshold_minor", "updated_at", "updated_by_account_id") ON TABLE "promotions"."free_shipping_thresholds" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "updated_at", "updated_by_account_id") ON TABLE "promotions"."market_settings" TO "mondapac_app";
