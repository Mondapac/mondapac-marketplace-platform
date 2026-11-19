-- Never run this against production after launch: it drops every redemption. Reverses
-- 20261116120000_promotions_redemptions: the grants, the table (with its triggers and indexes),
-- the guard functions, then the column of the codes.
SET lock_timeout = '5s';

REVOKE UPDATE ("uses_count", "spent_minor", "seller_share_minor", "platform_share_minor", "updated_at") ON TABLE "promotions"."promotion_usage" FROM "mondapac_app";
REVOKE UPDATE ("used_at", "redeemed_order_id") ON TABLE "promotions"."promotion_batch_codes" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "release_reason", "confirmed_at", "released_at") ON TABLE "promotions"."redemptions" FROM "mondapac_app";

DROP TRIGGER "promotion_batch_codes_redemption" ON "promotions"."promotion_batch_codes";
DROP TABLE "promotions"."redemptions";
DROP FUNCTION "promotions"."guard_redemption_transition"();
DROP FUNCTION "promotions"."guard_redemption_insert"();
DROP FUNCTION "promotions"."guard_batch_code_redemption"();

ALTER TABLE "promotions"."promotion_batch_codes"
  DROP CONSTRAINT "promotion_batch_codes_redeemed_check",
  DROP COLUMN "redeemed_order_id";
