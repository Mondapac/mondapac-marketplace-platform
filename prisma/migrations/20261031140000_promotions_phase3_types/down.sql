-- Never run this against production after launch: it drops every referral code, referral, credit
-- record and inbox row. Reverses 20261031140000_promotions_phase3_types: the grants first, then the
-- new tables (which drops their triggers, indexes and foreign keys) and the trigger functions, then the new columns and
-- checks, and last the two type checks of the phase 2 migration. The type checks are put back
-- last, so the down refuses when a promotion of a phase 3 type is still stored. Nothing is lost
-- then because the file runs as one transaction (as the reversibility script runs it), so the
-- refusal rolls the earlier steps back; run it any other way and the earlier steps stay applied.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "promotions"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "failure_code", "wallet_journal_id", "settled_at") ON TABLE "promotions"."credit_issuances" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "reject_reason", "decided_at", "qualifying_order_id", "qualifying_seller_order_id") ON TABLE "promotions"."referrals" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "promotions"."referral_codes" FROM "mondapac_app";
REVOKE UPDATE ("segment_kind", "segment_min_days", "referee_reward_minor") ON TABLE "promotions"."promotions" FROM "mondapac_app";

DROP TABLE "promotions"."inbox";
DROP TABLE "promotions"."credit_issuances";
DROP TABLE "promotions"."referrals";
DROP TABLE "promotions"."referral_codes";

DROP FUNCTION "promotions"."guard_credit_transition"();
DROP FUNCTION "promotions"."guard_referral_transition"();

ALTER TABLE "promotions"."promotions"
  DROP CONSTRAINT "promotions_phase3_check",
  DROP CONSTRAINT "promotions_type_funding_check",
  DROP CONSTRAINT "promotions_type_check";

ALTER TABLE "promotions"."promotions"
  DROP COLUMN "segment_kind",
  DROP COLUMN "segment_min_days",
  DROP COLUMN "referee_reward_minor";

ALTER TABLE "promotions"."promotions"
  ADD CONSTRAINT "promotions_type_check" CHECK ("type" IN ('SELLER_SALE', 'CART_DISCOUNT', 'CART_CODE', 'FREE_SHIPPING', 'CO_FUNDED_CAMPAIGN', 'TIERED_CART', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE', 'FLASH_SALE', 'BATCH_CODE')),
  ADD CONSTRAINT "promotions_type_funding_check" CHECK (
    ("type" = 'CO_FUNDED_CAMPAIGN') = ("funding" = 'CO_FUNDED')
    AND ("type" NOT IN ('SELLER_SALE', 'BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE') OR "funding" = 'SELLER')
    AND ("type" NOT IN ('FREE_SHIPPING', 'TIERED_CART', 'BATCH_CODE') OR "funding" = 'PLATFORM'));
