-- Never run this against production after launch: it drops every promotion, target, usage counter,
-- opt-in, review entry and setting. Reverses 20261028103200_promotions_core: the grants first,
-- then the tables (children first, which drops their triggers, indexes and foreign keys), then the
-- function. The empty schema "promotions" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("status", "updated_at", "updated_by_account_id") ON TABLE "promotions"."market_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("threshold_minor", "updated_at", "updated_by_account_id") ON TABLE "promotions"."free_shipping_thresholds" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("amount_minor", "cap_minor", "enabled", "kind", "min_spend_minor", "monthly_budget_minor", "percent_bps", "updated_at", "updated_by_account_id") ON TABLE "promotions"."first_order_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("decided_at", "decided_by_account_id", "status") ON TABLE "promotions"."promotion_reviews" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("decided_by_account_id", "opted_in_at", "withdrawn_at") ON TABLE "promotions"."co_funding_opt_ins" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "promotions"."promotion_usage" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "promotions"."promotion_targets" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("budget_minor", "cap_minor", "combinable", "ends_at", "max_per_order_minor", "max_total_uses", "max_uses_per_customer", "min_spend_minor", "name", "paused_by", "platform_split_bps", "prior_approved", "reward_amount_minor", "reward_bps", "reward_kind", "special_campaign", "starts_at", "status", "test_mode", "updated_at") ON TABLE "promotions"."promotions" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "promotions" FROM "mondapac_app";

DROP TABLE "promotions"."market_settings";
DROP TABLE "promotions"."free_shipping_thresholds";
DROP TABLE "promotions"."first_order_settings";
DROP TABLE "promotions"."promotion_reviews";
DROP TABLE "promotions"."co_funding_opt_ins";
DROP TABLE "promotions"."promotion_usage";
DROP TABLE "promotions"."promotion_targets";
DROP TABLE "promotions"."promotions";
DROP FUNCTION "promotions"."reject_mutation"();
