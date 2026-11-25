-- Reverses 20261125160100_catalog_offer_pending_change_emergency_stop. Development and CI only:
-- it fails while a change holds the reason `emergency-stop` (changes are never deleted).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_reasons_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 4
    AND "reasons" <@ ARRAY['certificate-badge', 'handling', 'contact-text', 'review-all']::text[]);
