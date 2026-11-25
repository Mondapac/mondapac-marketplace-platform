-- Risk-based Offer approval, slice 2c (ADR-0051), owner decision 2026-11-25: the emergency stop
-- (R0) also holds every watched edit of a live Offer, so a held change may carry the reason
-- `emergency-stop`. Only the reasons CHECK changes; the table is new in this release and small.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_reasons_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 5
    AND "reasons" <@ ARRAY['emergency-stop', 'certificate-badge', 'handling', 'contact-text', 'review-all']::text[]);
