-- Reverses 20261125160000_catalog_offer_pending_changes. Development and CI only: every pending
-- change and every `edit` referral is lost; Offers keep their live values.
-- The DISABLE/DELETE/ENABLE runs inside the migration transaction: if the DELETE fails, the
-- DISABLE rolls back with it. Do not run these statements by hand outside a transaction.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP INDEX "catalog"."offer_review_referrals_pending_change_id_key";
ALTER TABLE "catalog"."offer_review_referrals" DROP CONSTRAINT "offer_review_referrals_pending_change_fkey";
ALTER TABLE "catalog"."offer_review_referrals" DROP CONSTRAINT "offer_review_referrals_pending_change_check";
ALTER TABLE "catalog"."offer_review_referrals" DISABLE TRIGGER "offer_review_referrals_no_update_delete";
DELETE FROM "catalog"."offer_review_referrals" WHERE "trigger" = 'edit';
ALTER TABLE "catalog"."offer_review_referrals" ENABLE TRIGGER "offer_review_referrals_no_update_delete";
ALTER TABLE "catalog"."offer_review_referrals" DROP CONSTRAINT "offer_review_referrals_trigger_check";
ALTER TABLE "catalog"."offer_review_referrals"
  ADD CONSTRAINT "offer_review_referrals_trigger_check" CHECK ("trigger" IN ('first-publication'));
ALTER TABLE "catalog"."offer_review_referrals" DROP COLUMN "pending_change_id";

DROP TABLE "catalog"."offer_pending_changes";
DROP FUNCTION "catalog"."offer_pending_changes_guard"();
