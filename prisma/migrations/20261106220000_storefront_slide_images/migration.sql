-- File storage pilot F9: the slide image library. An admin uploads a picture once (and, if wanted,
-- a separate mobile picture); a slide names it by `content.image.ref`. The pictures go through the
-- shared image pipeline (decoded and written again as metadata-free JPEG renditions; the raw upload
-- is never stored). The Market is stored on every row.
--  1. `slide_images`: one row per upload, insert-only.
--  2. `slide_image_renditions`: desktop, desktop-small and, when present, mobile and mobile-small;
--     the object key is built from the ids (CHECK).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "storefront"."slide_images" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "has_mobile" BOOLEAN NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slide_images_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "storefront"."slide_image_renditions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "image_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,

    CONSTRAINT "slide_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "slide_image_renditions_market_id_object_key_key" ON "storefront"."slide_image_renditions"("market_id", "object_key");

-- AddForeignKey
ALTER TABLE "storefront"."slide_image_renditions" ADD CONSTRAINT "slide_image_renditions_market_id_image_id_fkey" FOREIGN KEY ("market_id", "image_id") REFERENCES "storefront"."slide_images"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written checks: closed lists, bounds and the key built from the ids.
ALTER TABLE "storefront"."slide_images"
  ADD CONSTRAINT "slide_images_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_images_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slide_images_pixels_check" CHECK ("pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000),
  ADD CONSTRAINT "slide_images_byte_size_check" CHECK ("byte_size" > 0);
ALTER TABLE "storefront"."slide_image_renditions"
  ADD CONSTRAINT "slide_image_renditions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_image_renditions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slide_image_renditions_size_code_check" CHECK ("size_code" IN ('desktop', 'desktop-small', 'mobile', 'mobile-small')),
  ADD CONSTRAINT "slide_image_renditions_object_key_check" CHECK (
    "object_key" = 'slide-images/' || "image_id"::text || '/' || "size_code"),
  ADD CONSTRAINT "slide_image_renditions_sha256_check" CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "slide_image_renditions_size_check" CHECK ("byte_size" > 0 AND "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000);

-- Grants: inserted and read, never updated or deleted by the application (a later cleanup of
-- unused images would add DELETE with its own migration).
GRANT SELECT, INSERT ON TABLE "storefront"."slide_images" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "storefront"."slide_image_renditions" TO "mondapac_app";
