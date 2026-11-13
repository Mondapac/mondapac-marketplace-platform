SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261112170000_catalog_seller_categories (data design 8.3). Development and CI only:
-- proposals, shelves and every Offer's shelf are lost.
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
DELETE FROM "catalog"."rate_counters" WHERE "kind" = 'category-propose.seller.day';
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day',
    'seller-import-check.seller.hour', 'seller-import-check.seller.day',
    'import-photo.seller.minute', 'import-photo.seller.day', 'add-sizes.account.hour'));
REVOKE UPDATE ("shelf_category_id") ON TABLE "catalog"."offers" FROM "mondapac_app";
ALTER TABLE "catalog"."offers" DROP CONSTRAINT "offers_market_id_shelf_category_id_seller_id_fkey";
ALTER TABLE "catalog"."offers" DROP COLUMN "shelf_category_id";
DROP TABLE "catalog"."category_proposals";
DROP FUNCTION "catalog"."category_proposals_guard"();
DROP TABLE "catalog"."seller_category_names";
DROP TABLE "catalog"."seller_categories";
DROP FUNCTION "catalog"."seller_categories_guard"();
