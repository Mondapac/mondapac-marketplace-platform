-- Catalog slice 13 (speed mode, "simple and safe" path chosen by the owner 2026-10-14): product
-- photos. The upload is decoded and re-encoded in the request, the raw upload is never stored,
-- and the three renditions (metadata-free JPEG) are the only copies. The scanner, the sandbox
-- and the cookieless public origin of ADR-0029 are not part of this migration.

-- CreateTable
CREATE TABLE "catalog"."product_images" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "catalog"."product_image_renditions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "image_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,

    CONSTRAINT "product_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code")
);

-- CreateTable
CREATE TABLE "catalog"."product_revision_images" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "product_revision_images_pkey" PRIMARY KEY ("market_id","revision_id","image_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_images_market_id_id_product_id_key" ON "catalog"."product_images"("market_id", "id", "product_id");
CREATE INDEX "product_images_market_id_product_id_created_at_idx" ON "catalog"."product_images"("market_id", "product_id", "created_at");
CREATE UNIQUE INDEX "product_image_renditions_market_id_object_key_key" ON "catalog"."product_image_renditions"("market_id", "object_key");
CREATE UNIQUE INDEX "product_revision_images_market_id_revision_id_position_key" ON "catalog"."product_revision_images"("market_id", "revision_id", "position");
CREATE INDEX "product_revision_images_market_id_image_id_idx" ON "catalog"."product_revision_images"("market_id", "image_id");

-- AddForeignKey
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "catalog"."product_image_renditions" ADD CONSTRAINT "product_image_renditions_market_id_image_id_product_id_fkey" FOREIGN KEY ("market_id", "image_id", "product_id") REFERENCES "catalog"."product_images"("market_id", "id", "product_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "catalog"."product_revision_images" ADD CONSTRAINT "product_revision_images_market_id_product_id_revision_id_fkey" FOREIGN KEY ("market_id", "product_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "catalog"."product_revision_images" ADD CONSTRAINT "product_revision_images_market_id_image_id_product_id_fkey" FOREIGN KEY ("market_id", "image_id", "product_id") REFERENCES "catalog"."product_images"("market_id", "id", "product_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written checks: closed lists, bounds and the per-product key prefix (Hassan L2/L3).
ALTER TABLE "catalog"."product_images"
  ADD CONSTRAINT "product_images_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_images_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_images_state_check" CHECK ("state" IN ('clean', 'taken-down')),
  ADD CONSTRAINT "product_images_pixels_check" CHECK ("pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000),
  ADD CONSTRAINT "product_images_byte_size_check" CHECK ("byte_size" > 0);
ALTER TABLE "catalog"."product_image_renditions"
  ADD CONSTRAINT "product_image_renditions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_image_renditions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_image_renditions_size_code_check" CHECK ("size_code" IN ('thumb', 'medium', 'large')),
  ADD CONSTRAINT "product_image_renditions_object_key_check" CHECK ("object_key" LIKE "product_id"::text || '/%'),
  ADD CONSTRAINT "product_image_renditions_sha256_check" CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "product_image_renditions_size_check" CHECK ("byte_size" > 0 AND "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000);
ALTER TABLE "catalog"."product_revision_images"
  ADD CONSTRAINT "product_revision_images_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_images_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_images_position_check" CHECK ("position" >= 1);

-- A revision holds only clean images (a taken-down image cannot join a new revision).
CREATE FUNCTION "catalog"."product_revision_images_clean"() RETURNS trigger
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
CREATE TRIGGER "product_revision_images_clean" BEFORE INSERT
  ON "catalog"."product_revision_images"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."product_revision_images_clean"();
CREATE TRIGGER "product_revision_images_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_images"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_images_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_images"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants: images are inserted and read, and deleted while no revision uses them (the foreign key
-- of product_revision_images refuses the delete otherwise); renditions go with their image by
-- the cascade, which needs no grant on the child. Nothing is updated yet.
GRANT SELECT, INSERT, DELETE ON TABLE "catalog"."product_images" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_image_renditions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_images" TO "mondapac_app";
