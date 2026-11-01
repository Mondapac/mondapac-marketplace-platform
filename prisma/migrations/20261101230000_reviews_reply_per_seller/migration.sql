-- Reviews package 4a: a review that moves to another seller (the buyer bought the product again
-- from someone else) clears the earlier seller's reply. The old reply is kept as 'superseded'
-- (never shown, never editable) so the new seller can write its own: the one-reply rule becomes
-- "one PUBLISHED reply per review" (partial unique index) instead of one row per review.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "reviews"."review_replies" DROP CONSTRAINT "review_replies_status_check";
ALTER TABLE "reviews"."review_replies"
  ADD CONSTRAINT "review_replies_status_check" CHECK ("status" IN ('published', 'hidden', 'removed', 'superseded'));

DROP INDEX "reviews"."review_replies_market_id_review_id_key";
CREATE UNIQUE INDEX "review_replies_market_id_review_id_live_key"
  ON "reviews"."review_replies" ("market_id", "review_id")
  WHERE "status" IN ('published', 'hidden', 'removed');
CREATE INDEX "review_replies_market_id_review_id_idx" ON "reviews"."review_replies" ("market_id", "review_id");
