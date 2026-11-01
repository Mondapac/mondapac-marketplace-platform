-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "promotions"."promotions" ADD COLUMN     "referee_reward_minor" BIGINT,
ADD COLUMN     "segment_kind" TEXT,
ADD COLUMN     "segment_min_days" SMALLINT;

-- CreateTable
CREATE TABLE "promotions"."referral_codes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateTable
CREATE TABLE "promotions"."referrals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "referrer_account_id" UUID NOT NULL,
    "referee_account_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "qualifying_order_id" UUID,
    "qualifying_seller_order_id" UUID,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions"."credit_issuances" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "order_id" UUID,
    "source_kind" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "failure_code" TEXT,
    "wallet_journal_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "credit_issuances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_market_id_code_hash_key" ON "promotions"."referral_codes"("market_id", "code_hash");

-- CreateIndex
CREATE INDEX "referrals_market_id_referrer_account_id_status_idx" ON "promotions"."referrals"("market_id", "referrer_account_id", "status");

-- CreateIndex
CREATE INDEX "referrals_market_id_promotion_id_status_idx" ON "promotions"."referrals"("market_id", "promotion_id", "status");

-- CreateIndex
CREATE INDEX "referrals_market_id_qualifying_seller_order_id_idx" ON "promotions"."referrals"("market_id", "qualifying_seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_market_id_id_key" ON "promotions"."referrals"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_market_id_referee_account_id_key" ON "promotions"."referrals"("market_id", "referee_account_id");

-- CreateIndex
-- The budget of a promotion is the sum of its PENDING and GRANTED credits: the amount is a trailing
-- key column, so that sum is an index-only scan (the design's INCLUDE, written as a key column so
-- Prisma knows the index and never drops it as drift).
CREATE INDEX "credit_issuances_market_id_promotion_id_status_amount_minor_idx" ON "promotions"."credit_issuances"("market_id", "promotion_id", "status", "amount_minor");

-- CreateIndex
CREATE INDEX "credit_issuances_market_id_promotion_id_created_at_id_idx" ON "promotions"."credit_issuances"("market_id", "promotion_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "credit_issuances_market_id_order_id_idx" ON "promotions"."credit_issuances"("market_id", "order_id");

-- CreateIndex
CREATE INDEX "credit_issuances_market_id_promotion_id_recipient_account_i_idx" ON "promotions"."credit_issuances"("market_id", "promotion_id", "recipient_account_id");

-- CreateIndex
-- The lookup by source without a status (the handler's findBySource): the partial unique indexes
-- below cannot serve it.
CREATE INDEX "credit_issuances_market_id_kind_source_id_idx" ON "promotions"."credit_issuances"("market_id", "kind", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_issuances_market_id_id_key" ON "promotions"."credit_issuances"("market_id", "id");

-- AddForeignKey
ALTER TABLE "promotions"."referrals" ADD CONSTRAINT "referrals_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotions"."credit_issuances" ADD CONSTRAINT "credit_issuances_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the CHECKs of the new columns and tables, the wider type lists, the never-deleted
-- triggers and the grants. The merged migrations are not edited: the two type CHECKs of the
-- phase 2 migration are replaced here.
ALTER TABLE "promotions"."promotions"
  DROP CONSTRAINT "promotions_type_check",
  DROP CONSTRAINT "promotions_type_funding_check";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_check" CHECK ("type" IN ('SELLER_SALE', 'CART_DISCOUNT', 'CART_CODE', 'FREE_SHIPPING', 'CO_FUNDED_CAMPAIGN', 'TIERED_CART', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'FLASH_SALE', 'BATCH_CODE', 'CUSTOMER_GROUP', 'STORE_FOLLOWER', 'REFERRAL', 'CASHBACK')),
  -- Who pays: a store-follower offer is the seller's own; a customer-group discount and the two
  -- wallet-credit types (referral, cashback) are the platform's.
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'STORE_FOLLOWER') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE', 'CUSTOMER_GROUP', 'REFERRAL', 'CASHBACK') OR "funding" = 'PLATFORM')),
  -- The phase 3 parameters are set for their type only. A customer-group discount has a segment
  -- (a returning customer has its days; a delivery-zone segment takes its zones from the targets);
  -- a referral pays a FIXED credit to the referrer, one to the new customer and caps the rewarded
  -- referrals of a referrer; a cashback is a PERCENT of the goods with a cap per order.
  ADD CONSTRAINT "promotions_phase3_check" CHECK (
    CASE "type"
      WHEN 'CUSTOMER_GROUP' THEN
        COALESCE("segment_kind" IN ('RETURNING_CUSTOMER', 'DELIVERY_ZONE'), false)
        AND CASE "segment_kind"
          WHEN 'RETURNING_CUSTOMER' THEN COALESCE("segment_min_days" BETWEEN 1 AND 3650, false)
          ELSE "segment_min_days" IS NULL
        END
        AND "referee_reward_minor" IS NULL
      WHEN 'REFERRAL' THEN
        COALESCE("referee_reward_minor" >= 1, false) AND "segment_kind" IS NULL AND "segment_min_days" IS NULL
        AND "reward_kind" = 'FIXED' AND "cap_minor" IS NULL AND "max_uses_per_customer" IS NOT NULL
      WHEN 'CASHBACK' THEN
        "reward_kind" = 'PERCENT' AND "cap_minor" IS NOT NULL
        AND "segment_kind" IS NULL AND "segment_min_days" IS NULL AND "referee_reward_minor" IS NULL
      ELSE "segment_kind" IS NULL AND "segment_min_days" IS NULL AND "referee_reward_minor" IS NULL
    END);

ALTER TABLE "promotions"."referral_codes"
  ADD CONSTRAINT "referral_codes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "referral_codes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "referral_codes_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "promotions"."referrals"
  ADD CONSTRAINT "referrals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "referrals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- Nobody refers themself.
  ADD CONSTRAINT "referrals_distinct_check" CHECK ("referrer_account_id" <> "referee_account_id"),
  ADD CONSTRAINT "referrals_status_check" CHECK ("status" IN ('PENDING', 'QUALIFIED', 'REJECTED', 'EXPIRED')),
  ADD CONSTRAINT "referrals_reject_reason_check" CHECK (
    ("status" = 'REJECTED') = ("reject_reason" IS NOT NULL)
    AND ("reject_reason" IS NULL OR "reject_reason" IN ('SAME_HOUSEHOLD', 'SAME_PAYMENT', 'CAP_REACHED', 'BUDGET_EXHAUSTED'))),
  ADD CONSTRAINT "referrals_decision_check" CHECK (
    ("status" = 'PENDING') = ("decided_at" IS NULL)
    AND ("status" = 'QUALIFIED') = ("qualifying_seller_order_id" IS NOT NULL)
    AND ("qualifying_seller_order_id" IS NULL) = ("qualifying_order_id" IS NULL)),
  ADD CONSTRAINT "referrals_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "promotions"."credit_issuances"
  ADD CONSTRAINT "credit_issuances_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "credit_issuances_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "credit_issuances_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "credit_issuances_amount_check" CHECK ("amount_minor" >= 1),
  -- A cashback comes from a delivered seller order; the two referral credits from the referral.
  ADD CONSTRAINT "credit_issuances_kind_check" CHECK (
    ("kind" = 'CASHBACK' AND "source_kind" = 'SELLER_ORDER' AND "order_id" IS NOT NULL)
    OR ("kind" IN ('REFERRER_REWARD', 'REFEREE_REWARD') AND "source_kind" = 'REFERRAL')),
  ADD CONSTRAINT "credit_issuances_status_check" CHECK ("status" IN ('PENDING', 'GRANTED', 'RECORDED', 'FAILED')),
  -- GRANTED has the wallet journal; RECORDED (a test order's intended credit) and PENDING have none;
  -- FAILED has the wallet's refusal; everything but PENDING is settled.
  ADD CONSTRAINT "credit_issuances_settled_check" CHECK (
    ("status" = 'PENDING') = ("settled_at" IS NULL)
    AND ("status" = 'GRANTED') = ("wallet_journal_id" IS NOT NULL)
    AND ("status" = 'FAILED') = ("failure_code" IS NOT NULL)),
  ADD CONSTRAINT "credit_issuances_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[a-z][a-z0-9.-]{1,63}$'),
  ADD CONSTRAINT "credit_issuances_idempotency_key_check" CHECK ("idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$');

ALTER TABLE "promotions"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^promotions\.[a-z0-9-]+$');

-- One credit of a kind per source, and one per idempotency key, among the REAL credits (PENDING,
-- GRANTED, FAILED): the event handler's idempotency. A RECORDED credit (the intended credit of a
-- test-mode promotion) has a slot of its own, so a note never keeps a real credit from being
-- made once a real promotion applies. (Partial indexes are not expressible in the Prisma schema.)
CREATE UNIQUE INDEX "credit_issuances_real_source_key"
  ON "promotions"."credit_issuances" ("market_id", "kind", "source_id") WHERE "status" <> 'RECORDED';
CREATE UNIQUE INDEX "credit_issuances_real_idempotency_key"
  ON "promotions"."credit_issuances" ("market_id", "idempotency_key") WHERE "status" <> 'RECORDED';
CREATE UNIQUE INDEX "credit_issuances_recorded_source_key"
  ON "promotions"."credit_issuances" ("market_id", "kind", "source_id") WHERE "status" = 'RECORDED';
CREATE UNIQUE INDEX "credit_issuances_recorded_idempotency_key"
  ON "promotions"."credit_issuances" ("market_id", "idempotency_key") WHERE "status" = 'RECORDED';

-- The only state changes: a PENDING credit is GRANTED or FAILED once; a PENDING referral is
-- QUALIFIED, REJECTED or EXPIRED once. Anything else (a settled row moving again, a RECORDED
-- note changing, a row going back to PENDING) is refused for every role, the owner included.
CREATE FUNCTION "promotions"."guard_credit_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" = 'PENDING' AND NEW."status" IN ('GRANTED', 'FAILED')
     AND NEW."id" = OLD."id"
     AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."promotion_id" = OLD."promotion_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."recipient_account_id" = OLD."recipient_account_id"
     AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
     AND NEW."source_kind" = OLD."source_kind"
     AND NEW."source_id" = OLD."source_id"
     AND NEW."amount_minor" = OLD."amount_minor"
     AND NEW."currency" = OLD."currency"
     AND NEW."idempotency_key" = OLD."idempotency_key"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.credit_issuances: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE FUNCTION "promotions"."guard_referral_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" = 'PENDING' AND NEW."status" IN ('QUALIFIED', 'REJECTED', 'EXPIRED')
     AND NEW."id" = OLD."id"
     AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."promotion_id" = OLD."promotion_id"
     AND NEW."referrer_account_id" = OLD."referrer_account_id"
     AND NEW."referee_account_id" = OLD."referee_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."expires_at" = OLD."expires_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.referrals: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "credit_issuances_transition" BEFORE UPDATE ON "promotions"."credit_issuances"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_credit_transition"();
CREATE TRIGGER "referrals_transition" BEFORE UPDATE ON "promotions"."referrals"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_referral_transition"();

-- A referral code, a referral and a credit are never deleted or truncated, whoever asks.
CREATE TRIGGER "referral_codes_no_delete" BEFORE DELETE ON "promotions"."referral_codes"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "referral_codes_no_truncate" BEFORE TRUNCATE ON "promotions"."referral_codes"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "referrals_no_delete" BEFORE DELETE ON "promotions"."referrals"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "referrals_no_truncate" BEFORE TRUNCATE ON "promotions"."referrals"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "credit_issuances_no_delete" BEFORE DELETE ON "promotions"."credit_issuances"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "credit_issuances_no_truncate" BEFORE TRUNCATE ON "promotions"."credit_issuances"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();

-- Grants. The new parameters of a promotion are editable like its reward; a referral code is
-- insert-only; a referral and a credit change state only; the inbox is insert-only.
GRANT UPDATE ("segment_kind", "segment_min_days", "referee_reward_minor") ON TABLE "promotions"."promotions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "promotions"."referral_codes" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "reject_reason", "decided_at", "qualifying_order_id", "qualifying_seller_order_id") ON TABLE "promotions"."referrals" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "failure_code", "wallet_journal_id", "settled_at") ON TABLE "promotions"."credit_issuances" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "promotions"."inbox" TO "mondapac_app";
