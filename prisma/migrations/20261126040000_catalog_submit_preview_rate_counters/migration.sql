-- The seller's submit preview (risk-based Offer approval slice 7b, ADR-0051): two more kinds in the
-- closed CHECK list of `rate_counters` (data design 3.26). `submit-preview.seller.minute` and
-- `submit-preview.seller.day` count a seller's dry runs of the review rules, so the preview cannot
-- be used to probe them. No table, no grant.

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
    'submit-preview.seller.minute', 'submit-preview.seller.day'));
