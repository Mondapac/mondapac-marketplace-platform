-- Reverses 20261117060000_promotions_seller_exclusive_segment. Rows with a SELLER_EXCLUSIVE
-- segment would fail the restored checks, so the down refuses while any exists.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "promotions"."promotions" WHERE "segment_kind" = 'SELLER_EXCLUSIVE') THEN
    RAISE EXCEPTION 'promotions with a SELLER_EXCLUSIVE segment exist; remove them before this down';
  END IF;
END $$;

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_type_funding_check";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'STORE_FOLLOWER') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE', 'CUSTOMER_GROUP', 'REFERRAL', 'CASHBACK') OR "funding" = 'PLATFORM'));

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_phase3_check";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_phase3_check" CHECK (
    CASE "type"
      WHEN 'CUSTOMER_GROUP' THEN
        COALESCE("segment_kind" IN ('RETURNING_CUSTOMER', 'DELIVERY_ZONE', 'MANUAL_GROUP'), false)
        AND CASE "segment_kind"
          WHEN 'RETURNING_CUSTOMER' THEN COALESCE("segment_min_days" BETWEEN 1 AND 3650, false)
          ELSE "segment_min_days" IS NULL
        END
        AND ("segment_kind" = 'MANUAL_GROUP') = ("segment_group_id" IS NOT NULL)
        AND "referee_reward_minor" IS NULL
      WHEN 'REFERRAL' THEN
        COALESCE("referee_reward_minor" >= 1, false) AND "segment_kind" IS NULL AND "segment_min_days" IS NULL
        AND "segment_group_id" IS NULL
        AND "reward_kind" = 'FIXED' AND "cap_minor" IS NULL AND "max_uses_per_customer" IS NOT NULL
      WHEN 'CASHBACK' THEN
        "reward_kind" = 'PERCENT' AND "cap_minor" IS NOT NULL
        AND "segment_kind" IS NULL AND "segment_min_days" IS NULL AND "segment_group_id" IS NULL
        AND "referee_reward_minor" IS NULL
      ELSE "segment_kind" IS NULL AND "segment_min_days" IS NULL AND "segment_group_id" IS NULL
        AND "referee_reward_minor" IS NULL
    END);
