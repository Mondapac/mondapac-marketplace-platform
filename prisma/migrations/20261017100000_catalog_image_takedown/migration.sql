-- Catalog slice 13 leftovers: photo takedown (catalog data design 3.19, 10.5) and Mojtaba's notes on
-- the clean-image trigger.
--
-- A photo moves `clean` -> `taken-down` once and never back (forward-only, the way certification
-- states move). The three takedown columns are set together with the state. The application role
-- gets a column-level UPDATE on exactly those four columns; nothing else of a photo changes.

ALTER TABLE "catalog"."product_images"
  ADD COLUMN "taken_down_at" TIMESTAMPTZ(6),
  ADD COLUMN "taken_down_by_account_id" UUID,
  ADD COLUMN "takedown_reason_code" TEXT;

ALTER TABLE "catalog"."product_images"
  ADD CONSTRAINT "product_images_takedown_check" CHECK (
    ("state" = 'taken-down') = ("taken_down_at" IS NOT NULL)
    AND ("state" = 'taken-down') = ("taken_down_by_account_id" IS NOT NULL)
    AND ("state" = 'taken-down') = ("takedown_reason_code" IS NOT NULL)
  ),
  ADD CONSTRAINT "product_images_takedown_reason_check" CHECK (
    "takedown_reason_code" IS NULL
    OR "takedown_reason_code" IN ('certification-mark', 'misleading', 'rights', 'unsafe-or-illegal', 'other')
  );

-- Forward-only: an UPDATE is allowed only on a clean photo and only to taken-down. A taken-down
-- photo is never changed again, and a photo never goes back to clean.
CREATE FUNCTION "catalog"."product_images_state_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'clean' OR NEW."state" <> 'taken-down' THEN
    RAISE EXCEPTION 'catalog.product_images: a photo can only go from clean to taken-down (% to %)',
      OLD."state", NEW."state" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "product_images_state_guard" BEFORE UPDATE
  ON "catalog"."product_images"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."product_images_state_guard"();

GRANT UPDATE ("state", "taken_down_at", "taken_down_by_account_id", "takedown_reason_code")
  ON TABLE "catalog"."product_images" TO "mondapac_app";

-- Mojtaba: the clean-image check now locks the photo row (FOR SHARE) so a takedown cannot commit
-- between the check and the revision photo insert. FOR SHARE needs UPDATE on at least one column,
-- which the grant above provides.
CREATE OR REPLACE FUNCTION "catalog"."product_revision_images_clean"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog"."product_images"
    WHERE "market_id" = NEW."market_id" AND "id" = NEW."image_id" AND "state" = 'clean'
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'catalog.product_revision_images: only a clean image can join a revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
