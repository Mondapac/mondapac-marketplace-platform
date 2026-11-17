-- Customers management phase 4c: a seller's cashback for its exclusive customers. A CASHBACK is
-- paid by the seller exactly when its segment is SELLER_EXCLUSIVE (so seller-owned, by
-- promotions_owner_check), otherwise by the platform as before; the segment takes no days and no
-- group. No new column.
SET lock_timeout = '5s';

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_type_funding_check";

-- As 20261117060000, with CASHBACK paid like a customer-group discount.
ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'STORE_FOLLOWER') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE', 'REFERRAL') OR "funding" = 'PLATFORM')
    AND ("type" NOT IN ('CUSTOMER_GROUP', 'CASHBACK')
      OR "funding" = CASE WHEN "segment_kind" = 'SELLER_EXCLUSIVE' THEN 'SELLER' ELSE 'PLATFORM' END));

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_phase3_check";

-- As 20261117060000, with a cashback's segment: none (the platform's) or SELLER_EXCLUSIVE.
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
        AND ("segment_kind" IS NULL OR "segment_kind" = 'SELLER_EXCLUSIVE')
        AND "segment_min_days" IS NULL AND "segment_group_id" IS NULL
        AND "referee_reward_minor" IS NULL
      ELSE "segment_kind" IS NULL AND "segment_min_days" IS NULL AND "segment_group_id" IS NULL
        AND "referee_reward_minor" IS NULL
    END);
