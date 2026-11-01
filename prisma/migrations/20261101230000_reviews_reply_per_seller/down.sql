-- Reverses 20261101230000_reviews_reply_per_seller. Superseded replies, and hidden or removed ones
-- that sit beside a newer published reply, are deleted first (history of a review that moved), then the one-row-per-review key and the old status list
-- come back. The grants of the table are not touched by the up migration.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP INDEX "reviews"."review_replies_market_id_review_id_idx";
DROP INDEX "reviews"."review_replies_market_id_review_id_published_key";
ALTER TABLE "reviews"."review_replies" DISABLE TRIGGER USER;
DELETE FROM "reviews"."review_replies" r
 WHERE r."status" = 'superseded'
    OR (r."status" <> 'published' AND EXISTS (
         SELECT 1 FROM "reviews"."review_replies" p
          WHERE p."market_id" = r."market_id" AND p."review_id" = r."review_id" AND p."status" = 'published'));
ALTER TABLE "reviews"."review_replies" ENABLE TRIGGER USER;
CREATE UNIQUE INDEX "review_replies_market_id_review_id_key" ON "reviews"."review_replies" ("market_id", "review_id");
ALTER TABLE "reviews"."review_replies" DROP CONSTRAINT "review_replies_status_check";
ALTER TABLE "reviews"."review_replies"
  ADD CONSTRAINT "review_replies_status_check" CHECK ("status" IN ('published', 'hidden', 'removed'));
