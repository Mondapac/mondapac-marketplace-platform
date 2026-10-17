SET lock_timeout = '5s';
-- Reverses 20261017100000_catalog_image_takedown. Taken-down photos would violate the earlier
-- state CHECK only if the CHECK still allowed them; it does (clean, taken-down), so the rows stay
-- and only the takedown columns are lost.
CREATE OR REPLACE FUNCTION "catalog"."product_revision_images_clean"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog"."product_images"
    WHERE "market_id" = NEW."market_id" AND "id" = NEW."image_id" AND "state" = 'clean'
  ) THEN
    RAISE EXCEPTION 'catalog.product_revision_images: only a clean image can join a revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE UPDATE ("state", "taken_down_at", "taken_down_by_account_id", "takedown_reason_code")
  ON TABLE "catalog"."product_images" FROM "mondapac_app";
DROP TRIGGER "product_images_state_guard" ON "catalog"."product_images";
DROP FUNCTION "catalog"."product_images_state_guard"();
ALTER TABLE "catalog"."product_images"
  DROP CONSTRAINT "product_images_takedown_reason_check",
  DROP CONSTRAINT "product_images_takedown_check",
  DROP COLUMN "takedown_reason_code",
  DROP COLUMN "taken_down_by_account_id",
  DROP COLUMN "taken_down_at";
