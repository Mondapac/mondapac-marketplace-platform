SET lock_timeout = '5s';
-- Catalog: the reversible admin pause of a published product (catalog design 4.1a, 4.4, M-5).
--
-- A product is paused by an admin (`paused_at`, `paused_by_account_id`): a mark on a `published`
-- product, not a status, so `unpublished`, `withdrawn` and `retired` stay terminal. Every Offer of
-- a paused product carries the stored off-sale cause `product-paused` (`off_sale_product_paused`),
-- added with the pause and cleared with the resume. The application role gets a column-level
-- UPDATE on exactly the new columns.

ALTER TABLE "catalog"."products"
  ADD COLUMN "paused_at" TIMESTAMPTZ(6),
  ADD COLUMN "paused_by_account_id" UUID;

ALTER TABLE "catalog"."products"
  ADD CONSTRAINT "products_paused_check" CHECK (
    ("paused_at" IS NULL) = ("paused_by_account_id" IS NULL)),
  -- Only a published product can be paused; retire and withdraw clear the mark in their unit.
  ADD CONSTRAINT "products_paused_status_check" CHECK (
    "paused_at" IS NULL OR "status" = 'published');

GRANT UPDATE ("paused_at", "paused_by_account_id") ON TABLE "catalog"."products" TO "mondapac_app";

-- The sixth stored cause. Existing rows have none of it; the default is dropped so the column
-- matches the Prisma model, which always writes it.
ALTER TABLE "catalog"."offers"
  ADD COLUMN "off_sale_product_paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "catalog"."offers" ALTER COLUMN "off_sale_product_paused" DROP DEFAULT;

ALTER TABLE "catalog"."offers" DROP CONSTRAINT "offers_listed_check";
ALTER TABLE "catalog"."offers"
  ADD CONSTRAINT "offers_listed_check" CHECK ("listed" = (
    "status" = 'published' AND NOT (
      "off_sale_type_not_allowed" OR "off_sale_product_retired" OR "off_sale_product_not_listed"
      OR "off_sale_product_paused" OR "off_sale_tag_suspended"
      OR "off_sale_description_claim_text"))) NOT VALID;
ALTER TABLE "catalog"."offers" VALIDATE CONSTRAINT "offers_listed_check";

ALTER TABLE "catalog"."offer_history" DROP CONSTRAINT "offer_history_off_sale_causes_check";
ALTER TABLE "catalog"."offer_history"
  ADD CONSTRAINT "offer_history_off_sale_causes_check" CHECK (
    "off_sale_causes" IS NOT NULL AND array_position("off_sale_causes", NULL) IS NULL
    AND "off_sale_causes" <@ ARRAY['type-not-allowed', 'product-retired', 'product-not-listed',
      'product-paused', 'tag-suspended', 'description-claim-text']::text[]) NOT VALID;
ALTER TABLE "catalog"."offer_history" VALIDATE CONSTRAINT "offer_history_off_sale_causes_check";

GRANT UPDATE ("off_sale_product_paused") ON TABLE "catalog"."offers" TO "mondapac_app";
