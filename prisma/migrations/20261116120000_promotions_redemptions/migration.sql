-- Promotions package T2 (redemption at checkout): what each order took from each promotion, the
-- single-use code an order redeemed, and the counters of `promotion_usage` kept by the app.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "promotions"."redemptions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "promotion_key" TEXT NOT NULL,
    "promotion_id" UUID,
    "kind" TEXT NOT NULL,
    "customer_account_id" UUID,
    "code_hash" TEXT,
    "currency" VARCHAR(3),
    "amount_minor" BIGINT NOT NULL,
    "seller_share_minor" BIGINT NOT NULL,
    "platform_share_minor" BIGINT NOT NULL,
    "units" INTEGER,
    "budget_month" TEXT,
    "status" TEXT NOT NULL,
    "release_reason" TEXT,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "promotions"."promotion_batch_codes" ADD COLUMN "redeemed_order_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "redemptions_market_id_order_id_promotion_key_key" ON "promotions"."redemptions"("market_id", "order_id", "promotion_key");

-- AddForeignKey
ALTER TABLE "promotions"."redemptions" ADD CONSTRAINT "redemptions_market_id_promotion_id_fkey" FOREIGN KEY ("market_id", "promotion_id") REFERENCES "promotions"."promotions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the CHECKs, the partial indexes, the transition guards and the grants.
ALTER TABLE "promotions"."redemptions"
  ADD CONSTRAINT "redemptions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "redemptions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "redemptions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- A stored promotion (its uuid as the key), the Market's first-order discount, the free delivery
  -- of one zone (the settings-based offers have no promotion row), or the order's head row: written
  -- with every redemption, or RELEASED alone when the order is cancelled before it was redeemed, so
  -- a redemption and a cancellation of one order always meet on the same unique key.
  ADD CONSTRAINT "redemptions_kind_check" CHECK (
    CASE "kind"
      WHEN 'PROMOTION' THEN "promotion_id" IS NOT NULL AND "promotion_key" = "promotion_id"::text
      WHEN 'FIRST_ORDER' THEN "promotion_id" IS NULL AND "promotion_key" = 'first-order'
      WHEN 'FREE_SHIPPING' THEN "promotion_id" IS NULL AND "promotion_key" ~ '^free-shipping:[A-Za-z0-9_-]{1,64}$'
      WHEN 'ORDER' THEN "promotion_id" IS NULL AND "promotion_key" = 'order'
      ELSE false
    END),
  -- Only a head row written by a cancellation may lack the customer and the currency.
  ADD CONSTRAINT "redemptions_customer_check" CHECK (
    ("customer_account_id" IS NOT NULL AND "currency" IS NOT NULL)
    OR ("kind" = 'ORDER' AND "status" = 'RELEASED')),
  ADD CONSTRAINT "redemptions_amounts_check" CHECK (
    "seller_share_minor" >= 0 AND "platform_share_minor" >= 0
    AND "seller_share_minor" + "platform_share_minor" = "amount_minor"
    AND (CASE WHEN "kind" = 'ORDER' THEN "amount_minor" = 0 ELSE "amount_minor" >= 1 END)),
  ADD CONSTRAINT "redemptions_units_check" CHECK ("units" IS NULL OR ("units" >= 1 AND "kind" = 'PROMOTION')),
  ADD CONSTRAINT "redemptions_code_hash_check" CHECK (
    "code_hash" IS NULL OR ("code_hash" ~ '^[0-9a-f]{64}$' AND "kind" = 'PROMOTION')),
  -- The month (in the Market's zone) whose first-order budget the row spends; first-order rows only.
  ADD CONSTRAINT "redemptions_budget_month_check" CHECK (
    ("kind" = 'FIRST_ORDER') = ("budget_month" IS NOT NULL)
    AND ("budget_month" IS NULL OR "budget_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
  ADD CONSTRAINT "redemptions_status_check" CHECK ("status" IN ('RESERVED', 'CONFIRMED', 'RELEASED')),
  ADD CONSTRAINT "redemptions_release_reason_check" CHECK (
    "release_reason" IS NULL OR "release_reason" IN ('ORDER_CANCELLED', 'ORDER_REFUNDED')),
  ADD CONSTRAINT "redemptions_state_check" CHECK (
    ("status" = 'RELEASED') = ("released_at" IS NOT NULL)
    AND ("status" = 'RELEASED') = ("release_reason" IS NOT NULL)
    AND ("status" <> 'RESERVED' OR "confirmed_at" IS NULL)
    AND ("status" <> 'CONFIRMED' OR "confirmed_at" IS NOT NULL)
    AND ("confirmed_at" IS NULL OR "confirmed_at" >= "reserved_at")
    AND ("released_at" IS NULL OR "released_at" >= "reserved_at")
    AND ("released_at" IS NULL OR "confirmed_at" IS NULL OR "released_at" >= "confirmed_at"));

-- A code is redeemed by exactly one order, named with the instant. Added NOT VALID and validated
-- apart, so the scan of existing codes holds only SHARE UPDATE EXCLUSIVE (no code was used before
-- T2: nothing wrote `used_at`).
ALTER TABLE "promotions"."promotion_batch_codes"
  ADD CONSTRAINT "promotion_batch_codes_redeemed_check" CHECK (("used_at" IS NULL) = ("redeemed_order_id" IS NULL)) NOT VALID;
ALTER TABLE "promotions"."promotion_batch_codes" VALIDATE CONSTRAINT "promotion_batch_codes_redeemed_check";

-- The counts the quote and the redemption read, each over the rows that hold (not RELEASED).
-- Uses of one promotion by one customer (max uses per customer).
CREATE INDEX "redemptions_customer_live_idx" ON "promotions"."redemptions" ("market_id", "promotion_id", "customer_account_id")
  WHERE "status" <> 'RELEASED';
-- Units sold of a flash sale.
CREATE INDEX "redemptions_units_live_idx" ON "promotions"."redemptions" ("market_id", "promotion_id", "units")
  WHERE "status" <> 'RELEASED' AND "units" IS NOT NULL;
-- The first-order spend of one month: index-only sum.
CREATE INDEX "redemptions_first_order_month_idx" ON "promotions"."redemptions" ("market_id", "budget_month", "amount_minor")
  WHERE "kind" = 'FIRST_ORDER' AND "status" <> 'RELEASED';
-- A customer's redemptions, newest first (the admin customer page).
CREATE INDEX "redemptions_customer_newest_idx" ON "promotions"."redemptions" ("market_id", "customer_account_id", "reserved_at" DESC, "id" DESC);
-- Reservations left open (the sweep).
CREATE INDEX "redemptions_reserved_idx" ON "promotions"."redemptions" ("market_id", "reserved_at", "id")
  WHERE "status" = 'RESERVED';
-- Backstops of the checks the redemption makes under its locks: a customer takes the first-order
-- discount once, and a single-use code holds one live redemption.
CREATE UNIQUE INDEX "redemptions_first_order_once_idx" ON "promotions"."redemptions" ("market_id", "customer_account_id")
  WHERE "kind" = 'FIRST_ORDER' AND "status" <> 'RELEASED';
CREATE UNIQUE INDEX "redemptions_code_live_idx" ON "promotions"."redemptions" ("market_id", "code_hash")
  WHERE "code_hash" IS NOT NULL AND "status" <> 'RELEASED';

-- A redemption is never deleted; it only moves RESERVED -> CONFIRMED, RESERVED -> RELEASED or
-- CONFIRMED -> RELEASED, and nothing else of the row changes, for every role (the owner too).
CREATE TRIGGER "redemptions_no_delete" BEFORE DELETE ON "promotions"."redemptions"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "redemptions_no_truncate" BEFORE TRUNCATE ON "promotions"."redemptions"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();

CREATE FUNCTION "promotions"."guard_redemption_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ((OLD."status" = 'RESERVED' AND NEW."status" IN ('CONFIRMED', 'RELEASED'))
      OR (OLD."status" = 'CONFIRMED' AND NEW."status" = 'RELEASED'))
     AND NEW."id" = OLD."id"
     AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."order_id" = OLD."order_id"
     AND NEW."promotion_key" = OLD."promotion_key"
     AND NEW."promotion_id" IS NOT DISTINCT FROM OLD."promotion_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."customer_account_id" = OLD."customer_account_id"
     AND NEW."code_hash" IS NOT DISTINCT FROM OLD."code_hash"
     AND NEW."currency" = OLD."currency"
     AND NEW."amount_minor" = OLD."amount_minor"
     AND NEW."seller_share_minor" = OLD."seller_share_minor"
     AND NEW."platform_share_minor" = OLD."platform_share_minor"
     AND NEW."units" IS NOT DISTINCT FROM OLD."units"
     AND NEW."budget_month" IS NOT DISTINCT FROM OLD."budget_month"
     AND NEW."reserved_at" = OLD."reserved_at"
     AND (OLD."confirmed_at" IS NULL OR NEW."confirmed_at" = OLD."confirmed_at")
     AND (OLD."status" <> 'RESERVED' OR NEW."status" <> 'RELEASED' OR NEW."confirmed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.redemptions: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "redemptions_transition" BEFORE UPDATE ON "promotions"."redemptions"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_redemption_transition"();

-- A redemption starts RESERVED; the only row born RELEASED is the head row of an order cancelled
-- before it was redeemed. Nothing is inserted CONFIRMED.
CREATE FUNCTION "promotions"."guard_redemption_insert"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."status" = 'RESERVED' AND NEW."confirmed_at" IS NULL AND NEW."released_at" IS NULL)
     OR (NEW."status" = 'RELEASED' AND NEW."kind" = 'ORDER' AND NEW."confirmed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.redemptions: a row is inserted RESERVED'
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "redemptions_insert" BEFORE INSERT ON "promotions"."redemptions"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_redemption_insert"();

-- A single-use code is claimed by one order (unused -> used) or given back by that order
-- (used -> unused); its hash, promotion and batch never change.
CREATE FUNCTION "promotions"."guard_batch_code_redemption"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."code_hash" = OLD."code_hash"
     AND NEW."promotion_id" = OLD."promotion_id"
     AND NEW."batch_id" = OLD."batch_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((OLD."used_at" IS NULL AND NEW."used_at" IS NOT NULL)
          OR (OLD."used_at" IS NOT NULL AND NEW."used_at" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.promotion_batch_codes: change not allowed'
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "promotion_batch_codes_redemption" BEFORE UPDATE ON "promotions"."promotion_batch_codes"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_batch_code_redemption"();

-- Grants. Redemptions are inserted and change state only; a code's use is set and cleared; the
-- usage counters move with each redemption and release (the core CHECK keeps them >= 0).
GRANT SELECT, INSERT, UPDATE ("status", "release_reason", "confirmed_at", "released_at") ON TABLE "promotions"."redemptions" TO "mondapac_app";
GRANT UPDATE ("used_at", "redeemed_order_id") ON TABLE "promotions"."promotion_batch_codes" TO "mondapac_app";
GRANT UPDATE ("uses_count", "spent_minor", "seller_share_minor", "platform_share_minor", "updated_at") ON TABLE "promotions"."promotion_usage" TO "mondapac_app";
