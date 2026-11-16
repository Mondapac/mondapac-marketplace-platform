-- Reverses 20261116060001_promotions_manual_group_segment. Rows with a MANUAL_GROUP segment would
-- fail the restored check, so the down refuses while any exists (nothing is silently changed).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "promotions"."promotions" WHERE "segment_kind" = 'MANUAL_GROUP') THEN
    RAISE EXCEPTION 'promotions with a MANUAL_GROUP segment exist; remove them before this down';
  END IF;
END $$;

ALTER TABLE "promotions"."promotions" DROP CONSTRAINT "promotions_phase3_check";

ALTER TABLE "promotions"."promotions"
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

ALTER TABLE "promotions"."promotions" DROP COLUMN "segment_group_id";
