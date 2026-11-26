-- The submit preview's contact-text mark (risk-based Offer approval slice 7b, ADR-0051; security
-- M1 of PR 1376). A preview that tells the seller `contact-text` counts
-- `submit-preview-contact.seller.month` on the seller (data design 3.26, keyed hash only); an Offer
-- that seller then publishes at once within 30 days goes on the post-publication review list with
-- the new reason `preview-contact-text`, keyed like a sample on the Offer version published. No
-- table, no grant; the answers of the preview and of the submit do not change.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

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
    'submit-preview.seller.minute', 'submit-preview.seller.day',
    'submit-preview-contact.seller.month'));

ALTER TABLE "catalog"."offer_post_reviews" DROP CONSTRAINT "offer_post_reviews_reasons_check";
ALTER TABLE "catalog"."offer_post_reviews"
  ADD CONSTRAINT "offer_post_reviews_reasons_check" CHECK (
    "reasons" IS NOT NULL
    AND array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 5
    AND "reasons" <@ ARRAY['sample', 'price-no-reference', 'price-reference-unavailable',
      'price-recheck-outside', 'preview-contact-text']::text[]);

ALTER TABLE "catalog"."offer_post_review_reasons"
  DROP CONSTRAINT "offer_post_review_reasons_reason_check",
  DROP CONSTRAINT "offer_post_review_reasons_source_kind_check";
ALTER TABLE "catalog"."offer_post_review_reasons"
  ADD CONSTRAINT "offer_post_review_reasons_reason_check" CHECK ("reason" IN
    ('sample', 'price-no-reference', 'price-reference-unavailable', 'price-recheck-outside',
     'preview-contact-text')),
  -- A sample and a preview mark are keyed on the Offer version published; a price reason on its
  -- pricing record.
  ADD CONSTRAINT "offer_post_review_reasons_source_kind_check" CHECK (
    ("reason" IN ('sample', 'preview-contact-text')) = ("source_ref" LIKE 'offer-version:%'));
