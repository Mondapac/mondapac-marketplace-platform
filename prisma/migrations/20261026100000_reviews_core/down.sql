-- Never run this against production after launch: it drops every review, rating, reply, report,
-- moderation row and summary. Reverses 20261026100000_reviews_core: the grants first, then the
-- tables (children first, which drops their triggers, indexes and foreign keys), then the function.
-- The empty schema "reviews" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("status", "updated_at", "updated_by_account_id") ON TABLE "reviews"."market_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("arrived_ok_yes", "as_described_yes", "count", "histogram_1", "histogram_2", "histogram_3", "histogram_4", "histogram_5", "rated_seller_orders", "rebuilt_at", "satisfied_count", "sum") ON TABLE "reviews"."rating_summaries" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status") ON TABLE "reviews"."review_reports" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("body", "edited_at", "status") ON TABLE "reviews"."review_replies" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("account_id", "seller_order_id", "status") ON TABLE "reviews"."seller_ratings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("account_id", "anonymous", "body", "created_at", "deleted_at", "edited_at", "last_purchase_at", "last_seller_order_id", "locale", "offer_id", "published_at", "rating", "seller_id", "status", "title") ON TABLE "reviews"."product_reviews" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "reviews"."review_signals" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "reviews"."moderation_actions" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "reviews" FROM "mondapac_app";

DROP TABLE "reviews"."market_settings";
DROP TABLE "reviews"."rating_summaries";
DROP TABLE "reviews"."review_signals";
DROP TABLE "reviews"."moderation_actions";
DROP TABLE "reviews"."review_reports";
DROP TABLE "reviews"."review_replies";
DROP TABLE "reviews"."seller_ratings";
DROP TABLE "reviews"."product_reviews";
DROP FUNCTION "reviews"."reject_mutation"();
