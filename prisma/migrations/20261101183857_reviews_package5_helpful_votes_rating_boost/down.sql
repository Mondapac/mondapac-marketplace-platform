-- Reverses 20261101183857_reviews_package5_helpful_votes_rating_boost: the helpful votes (and the
-- count they keep) and the search copy of the star totals go with their tables and column. A
-- development rollback; it drops every vote. The copy in "search" is rebuilt by its job.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("rating_count", "rating_sum", "bayes_times_1000", "boost_ppm", "synced_at"), DELETE ON TABLE "search"."product_ratings" FROM "mondapac_app";
REVOKE UPDATE ("helpful_count") ON TABLE "reviews"."product_reviews" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "reviews"."helpful_votes" FROM "mondapac_app";

DROP TABLE "search"."product_ratings";
DROP TABLE "reviews"."helpful_votes";
DROP TRIGGER "product_reviews_guard_helpful_count" ON "reviews"."product_reviews";
DROP FUNCTION "reviews"."guard_helpful_count"();
DROP FUNCTION "reviews"."keep_helpful_count"();
DROP INDEX "reviews"."product_reviews_public_list_helpful_idx";
ALTER TABLE "reviews"."product_reviews" DROP COLUMN "helpful_count";
