SET lock_timeout = '5s';
-- Reverses 20261030110000_catalog_product_pause. A rollback must never put a paused product back
-- on sale: the Offers of a paused product swap the dropped cause for `product-not-listed`, which
-- the older code knows (the pause itself cannot be undone then). The insert-only history keeps
-- its rows, so its older cause CHECK comes back NOT VALID: it guards new rows, not the old ones.
UPDATE "catalog"."offers" SET "off_sale_product_not_listed" = true
  WHERE "off_sale_product_paused" AND "status" <> 'deleted';
REVOKE UPDATE ("off_sale_product_paused") ON TABLE "catalog"."offers" FROM "mondapac_app";

ALTER TABLE "catalog"."offer_history" DROP CONSTRAINT "offer_history_off_sale_causes_check";
ALTER TABLE "catalog"."offer_history"
  ADD CONSTRAINT "offer_history_off_sale_causes_check" CHECK (
    "off_sale_causes" IS NOT NULL AND array_position("off_sale_causes", NULL) IS NULL
    AND "off_sale_causes" <@ ARRAY['type-not-allowed', 'product-retired', 'product-not-listed',
      'tag-suspended', 'description-claim-text']::text[]) NOT VALID;

ALTER TABLE "catalog"."offers" DROP CONSTRAINT "offers_listed_check";
ALTER TABLE "catalog"."offers"
  ADD CONSTRAINT "offers_listed_check" CHECK ("listed" = (
    "status" = 'published' AND NOT (
      "off_sale_type_not_allowed" OR "off_sale_product_retired" OR "off_sale_product_not_listed"
      OR "off_sale_tag_suspended" OR "off_sale_description_claim_text"))) NOT VALID;
ALTER TABLE "catalog"."offers" VALIDATE CONSTRAINT "offers_listed_check";
ALTER TABLE "catalog"."offers" DROP COLUMN "off_sale_product_paused";

REVOKE UPDATE ("paused_at", "paused_by_account_id") ON TABLE "catalog"."products" FROM "mondapac_app";
ALTER TABLE "catalog"."products"
  DROP CONSTRAINT "products_paused_status_check",
  DROP CONSTRAINT "products_paused_check",
  DROP COLUMN "paused_by_account_id",
  DROP COLUMN "paused_at";
