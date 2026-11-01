-- Reverses 20261101230000_reviews_reply_per_seller. History is trimmed so the old one-row-per-review
-- key can come back: superseded replies are deleted, and when a review still has several replies
-- only one stays (the published one, else the newest). The delete trigger is switched off for these
-- statements only; the grants of the table are not touched by the up migration.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP INDEX "reviews"."review_replies_market_id_review_id_idx";
DROP INDEX "reviews"."review_replies_market_id_review_id_published_key";

ALTER TABLE "reviews"."review_replies" DISABLE TRIGGER "review_replies_no_delete";
DELETE FROM "reviews"."review_replies" WHERE "status" = 'superseded';
DELETE FROM "reviews"."review_replies" r
  USING (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "market_id", "review_id"
             ORDER BY ("status" = 'published') DESC, "created_at" DESC, "id" DESC
           ) AS rn
      FROM "reviews"."review_replies"
  ) ranked
 WHERE r."id" = ranked."id" AND ranked.rn > 1;
ALTER TABLE "reviews"."review_replies" ENABLE TRIGGER "review_replies_no_delete";

CREATE UNIQUE INDEX "review_replies_market_id_review_id_key" ON "reviews"."review_replies" ("market_id", "review_id");
ALTER TABLE "reviews"."review_replies" DROP CONSTRAINT "review_replies_status_check";
ALTER TABLE "reviews"."review_replies"
  ADD CONSTRAINT "review_replies_status_check" CHECK ("status" IN ('published', 'hidden', 'removed'));
