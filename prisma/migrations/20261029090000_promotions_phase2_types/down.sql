-- Never run this against production after launch: it drops every tier, bundle item and generated
-- code. Reverses 20261029090000_promotions_phase2_types: the grants first, then the new tables
-- (which drops their triggers, indexes and foreign keys), then the new columns and checks, and last
-- the two type checks of the core migration. The type checks are put back last, so the down
-- refuses (and nothing is lost) when a promotion of a phase 2 type is still stored.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "promotions"."promotion_batch_codes" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_bundle_items" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_tiers" FROM "mondapac_app";
REVOKE UPDATE ("buy_qty", "flash_time_zone", "flash_unit_limit", "get_qty", "group_qty", "max_repeats_per_order") ON TABLE "promotions"."promotions" FROM "mondapac_app";

DROP TABLE "promotions"."promotion_batch_codes";
DROP TABLE "promotions"."promotion_bundle_items";
DROP TABLE "promotions"."promotion_tiers";

ALTER TABLE "promotions"."promotions"
  DROP CONSTRAINT "promotions_flash_check",
  DROP CONSTRAINT "promotions_params_check",
  DROP CONSTRAINT "promotions_type_funding_check",
  DROP CONSTRAINT "promotions_type_check";

ALTER TABLE "promotions"."promotions"
  DROP COLUMN "buy_qty",
  DROP COLUMN "flash_time_zone",
  DROP COLUMN "flash_unit_limit",
  DROP COLUMN "get_qty",
  DROP COLUMN "group_qty",
  DROP COLUMN "max_repeats_per_order";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_check" CHECK ("type" IN ('SELLER_SALE', 'CART_DISCOUNT', 'CART_CODE', 'FREE_SHIPPING', 'CO_FUNDED_CAMPAIGN')),
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" <> 'SELLER_SALE' OR "funding" = 'SELLER')
    AND ("type" <> 'FREE_SHIPPING' OR "funding" = 'PLATFORM'));
