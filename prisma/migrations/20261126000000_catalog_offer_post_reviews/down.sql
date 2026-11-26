-- Reverses 20261126000000_catalog_offer_post_reviews. Development and CI only: every
-- post-publication review row and its reasons are lost (taken-down Offers stay in Changes needed).
-- It fails while a held change was superseded by a take-down (changes are never deleted).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_superseded_cause_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_superseded_cause_check" CHECK (
    ("status" = 'superseded') = ("superseded_cause" IS NOT NULL)
    AND ("superseded_cause" IS NULL OR "superseded_cause" IN ('resubmitted', 'offer-deleted')));

DROP TABLE "catalog"."offer_post_review_reasons";
DROP TABLE "catalog"."offer_post_reviews";
DROP FUNCTION "catalog"."offer_post_review_reasons_guard"();
DROP FUNCTION "catalog"."offer_post_reviews_guard"();
