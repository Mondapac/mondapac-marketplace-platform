-- Customers management phase 4a: a seller's customer-group discount for its exclusive customers
-- (the customers who joined through its invite link). Segment SELLER_EXCLUSIVE: seller-funded (so
-- seller-owned, by promotions_owner_check), with no days, group or zones. Every other
-- customer-group discount stays the platform's. No new column.
SET lock_timeout = '5s';

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_type_funding_check";

-- As 20261031140000, with CUSTOMER_GROUP paid by the seller exactly for SELLER_EXCLUSIVE.
ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'STORE_FOLLOWER') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE', 'REFERRAL', 'CASHBACK') OR "funding" = 'PLATFORM')
    AND ("type" <> 'CUSTOMER_GROUP'
      OR "funding" = CASE WHEN "segment_kind" = 'SELLER_EXCLUSIVE' THEN 'SELLER' ELSE 'PLATFORM' END));

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_phase3_check";

-- As 20261116060001, plus SELLER_EXCLUSIVE (no days, no group).
ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_phase3_check" CHECK (
    CASE "type"
      WHEN 'CUSTOMER_GROUP' THEN
        COALESCE("segment_kind" IN ('RETURNING_CUSTOMER', 'DELIVERY_ZONE', 'MANUAL_GROUP', 'SELLER_EXCLUSIVE'), false)
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
