-- Reverses 20261126050000_catalog_preview_contact_mark. Development and CI only: the marks are
-- lost, and it fails while a post-publication review carries `preview-contact-text` (those rows
-- are never deleted).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."offer_post_review_reasons"
  DROP CONSTRAINT "offer_post_review_reasons_reason_check",
  DROP CONSTRAINT "offer_post_review_reasons_source_kind_check";
ALTER TABLE "catalog"."offer_post_review_reasons"
  ADD CONSTRAINT "offer_post_review_reasons_reason_check" CHECK ("reason" IN
    ('sample', 'price-no-reference', 'price-reference-unavailable', 'price-recheck-outside')),
  ADD CONSTRAINT "offer_post_review_reasons_source_kind_check" CHECK (
    ("reason" = 'sample') = ("source_ref" LIKE 'offer-version:%'));

ALTER TABLE "catalog"."offer_post_reviews" DROP CONSTRAINT "offer_post_reviews_reasons_check";
ALTER TABLE "catalog"."offer_post_reviews"
  ADD CONSTRAINT "offer_post_reviews_reasons_check" CHECK (
    "reasons" IS NOT NULL
    AND array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 4
    AND "reasons" <@ ARRAY['sample', 'price-no-reference', 'price-reference-unavailable',
      'price-recheck-outside']::text[]);

DELETE FROM "catalog"."rate_counters" WHERE "kind" = 'submit-preview-contact.seller.month';
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day',
    'seller-import-check.seller.hour', 'seller-import-check.seller.day',
    'import-photo.seller.minute', 'import-photo.seller.day', 'add-sizes.account.hour',
    'category-propose.seller.day',
    'ai-suggest.account.day', 'ai-suggest.account.minute', 'ai-suggest.market.day',
    'submit-preview.seller.minute', 'submit-preview.seller.day'));
