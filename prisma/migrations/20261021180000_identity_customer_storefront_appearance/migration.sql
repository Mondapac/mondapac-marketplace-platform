-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- A customer's kept storefront look (buyer account Settings): a palette and a text size. NULL
-- means "no choice" (the browser's own choice stays). Two nullable columns, no default: a
-- metadata-only change; every existing row passes the CHECKs (both columns are new). The CHECKs
-- validate under the ALTER's lock: no deployed environment exists and the table holds test and
-- demo accounts only, so they are not NOT VALID (as 20261016220000_identity_account_preferences).
-- The ids are those of STOREFRONT_PALETTES and STOREFRONT_TEXT_SIZES
-- (apps/api/src/modules/identity/domain/storefront-appearance.ts): a new look needs a migration
-- that replaces the CHECK, in the same change.
ALTER TABLE "identity"."accounts" ADD COLUMN "storefront_palette" VARCHAR(8);
ALTER TABLE "identity"."accounts" ADD COLUMN "storefront_text_size" VARCHAR(8);

ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_storefront_palette_check"
    CHECK ("storefront_palette" IS NULL OR "storefront_palette" IN ('A', 'B', 'C', 'D')),
  ADD CONSTRAINT "accounts_storefront_text_size_check"
    CHECK ("storefront_text_size" IS NULL OR "storefront_text_size" IN ('auto', 'large', 'small')),
  -- Only a customer account keeps a storefront look.
  ADD CONSTRAINT "accounts_storefront_appearance_customer_check"
    CHECK (("storefront_palette" IS NULL AND "storefront_text_size" IS NULL) OR "population" = 'customer');

