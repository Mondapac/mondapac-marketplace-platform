-- Reverses 20261125170000_offer_review_probation. Development and CI only: every standing, credit,
-- category flag, seller flag and their change logs are lost (sellers return to probation with no
-- credit). It fails while a held change carries the reason `sensitive-category` (changes are
-- never deleted).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_reasons_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 5
    AND "reasons" <@ ARRAY['emergency-stop', 'certificate-badge', 'handling', 'contact-text', 'review-all']::text[]);

DROP TABLE "catalog"."category_offer_review_changes";
DROP TABLE "catalog"."category_offer_review_flags";
DROP TABLE "catalog"."seller_review_credits";
DROP TABLE "catalog"."seller_review_standings";
DROP TABLE "sellers"."offer_review_flag_changes";
DROP FUNCTION "catalog"."category_offer_review_changes_guard"();
DROP FUNCTION "catalog"."category_offer_review_flags_guard"();
DROP FUNCTION "catalog"."seller_review_credits_guard"();
DROP FUNCTION "catalog"."seller_review_standings_guard"();
DROP FUNCTION "sellers"."offer_review_flag_changes_guard"();

ALTER TABLE "sellers"."seller_admin_settings"
  DROP CONSTRAINT "seller_admin_settings_offer_review_trusted_changed_check",
  DROP CONSTRAINT "seller_admin_settings_offer_review_full_review_changed_check",
  DROP CONSTRAINT "seller_admin_settings_offer_review_stop_changed_check",
  DROP COLUMN "offer_review_full_review",
  DROP COLUMN "offer_review_full_review_changed_at",
  DROP COLUMN "offer_review_full_review_changed_by_account_id",
  DROP COLUMN "offer_review_stop",
  DROP COLUMN "offer_review_stop_changed_at",
  DROP COLUMN "offer_review_stop_changed_by_account_id",
  DROP COLUMN "offer_review_trusted_from_start",
  DROP COLUMN "offer_review_trusted_from_start_changed_at",
  DROP COLUMN "offer_review_trusted_from_start_changed_by_account_id";
