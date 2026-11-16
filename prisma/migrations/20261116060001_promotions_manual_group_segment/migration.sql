-- Customers management phase 2 (PR 2a): a customer-group discount can target one of the Market's
-- manual customer groups (owned by `customers`). Only the group's id is kept here, with no foreign
-- key across modules; whether a customer is in the group is asked at the quote (fail closed).
SET lock_timeout = '5s';

ALTER TABLE "promotions"."promotions" ADD COLUMN "segment_group_id" UUID;

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_phase3_check";

-- As 20261031140000, plus MANUAL_GROUP: its group id is set, and set for that segment only.
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

GRANT UPDATE ("segment_group_id") ON TABLE "promotions"."promotions" TO "mondapac_app";
