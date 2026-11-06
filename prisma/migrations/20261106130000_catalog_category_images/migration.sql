-- Categories package C3c (plan section 4 "Image / Icon"; C3 amendment "Image"): the category image.
-- The upload goes through the product image pipeline (decoded and written again as three
-- metadata-free JPEG renditions; the raw upload is never stored), with its own tables because a
-- `product_images` row belongs to a product. The Market is stored on every row.
--  1. `category_images`: at most one image per category (unique `(market_id, category_id)`).
--  2. `category_image_renditions`: thumb, medium and large; the object key is built from the ids
--     (CHECK), so a rendition never names another category's file.
--  3. `platform_categories.image_id` now points at the category's own image: FK
--     `(market_id, image_id, id)` -> `category_images(market_id, id, category_id)`. An image of
--     another Market or another category cannot be set, and the current image cannot be deleted.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."category_images" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_images_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "catalog"."category_image_renditions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "image_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,

    CONSTRAINT "category_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_images_market_id_category_id_key" ON "catalog"."category_images"("market_id", "category_id");
CREATE UNIQUE INDEX "category_images_market_id_id_category_id_key" ON "catalog"."category_images"("market_id", "id", "category_id");
CREATE UNIQUE INDEX "category_image_renditions_market_id_object_key_key" ON "catalog"."category_image_renditions"("market_id", "object_key");

-- AddForeignKey
ALTER TABLE "catalog"."category_images" ADD CONSTRAINT "category_images_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "catalog"."category_image_renditions" ADD CONSTRAINT "category_image_renditions_market_id_image_id_category_id_fkey" FOREIGN KEY ("market_id", "image_id", "category_id") REFERENCES "catalog"."category_images"("market_id", "id", "category_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written checks: closed lists, bounds and the key built from the ids.
ALTER TABLE "catalog"."category_images"
  ADD CONSTRAINT "category_images_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_images_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_images_pixels_check" CHECK ("pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000),
  ADD CONSTRAINT "category_images_byte_size_check" CHECK ("byte_size" > 0);
ALTER TABLE "catalog"."category_image_renditions"
  ADD CONSTRAINT "category_image_renditions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_image_renditions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_image_renditions_size_code_check" CHECK ("size_code" IN ('thumb', 'medium', 'large')),
  ADD CONSTRAINT "category_image_renditions_object_key_check" CHECK (
    "object_key" = 'category-images/' || "category_id"::text || '/' || "image_id"::text || '/' || "size_code"),
  ADD CONSTRAINT "category_image_renditions_sha256_check" CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "category_image_renditions_size_check" CHECK ("byte_size" > 0 AND "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000);

-- The pointer of the category to its own image. Every row has image_id NULL today (C3a refused a
-- non-null one), so the constraint holds; it is still added NOT VALID and then validated (8.2).
ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_market_id_image_id_id_fkey"
    FOREIGN KEY ("market_id", "image_id", "id") REFERENCES "catalog"."category_images"("market_id", "id", "category_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "catalog"."platform_categories"
  VALIDATE CONSTRAINT "platform_categories_market_id_image_id_id_fkey";

-- Grants: an image is inserted, read and deleted once the category no longer points at it (the
-- foreign key above refuses the delete otherwise); renditions go with their image by the cascade.
-- `image_id` of platform_categories is already updatable (C2). Nothing here is updated.
GRANT SELECT, INSERT, DELETE ON TABLE "catalog"."category_images" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."category_image_renditions" TO "mondapac_app";
