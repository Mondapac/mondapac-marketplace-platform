-- Blog media upload: the blog's own picture library. An admin uploads a picture once; the cover of
-- a post (`cover_image_id`) and an image block (`imageId`) name it by id. The pictures go through
-- the shared image pipeline (decoded and written again as metadata-free JPEG renditions; the raw
-- upload is never stored). The Market is stored on every row; no key to another schema.
--  1. `media`: one row per upload, insert-only; listed newest first.
--  2. `media_renditions`: `large` and `thumb`; the object key is built from the ids (CHECK).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "blog"."media" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "blog"."media_renditions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "media_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,

    CONSTRAINT "media_renditions_pkey" PRIMARY KEY ("market_id","media_id","size_code")
);

-- CreateIndex
CREATE INDEX "media_market_id_created_at_id_idx" ON "blog"."media"("market_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "media_renditions_market_id_object_key_key" ON "blog"."media_renditions"("market_id", "object_key");

-- AddForeignKey
ALTER TABLE "blog"."media_renditions" ADD CONSTRAINT "media_renditions_market_id_media_id_fkey" FOREIGN KEY ("market_id", "media_id") REFERENCES "blog"."media"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written checks: closed lists, bounds and the key built from the ids.
ALTER TABLE "blog"."media"
  ADD CONSTRAINT "media_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "media_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "media_pixels_check" CHECK ("pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000),
  ADD CONSTRAINT "media_byte_size_check" CHECK ("byte_size" > 0);
ALTER TABLE "blog"."media_renditions"
  ADD CONSTRAINT "media_renditions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "media_renditions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "media_renditions_size_code_check" CHECK ("size_code" IN ('large', 'thumb')),
  ADD CONSTRAINT "media_renditions_object_key_check" CHECK (
    "object_key" = 'blog-media/' || "media_id"::text || '/' || "size_code"),
  ADD CONSTRAINT "media_renditions_sha256_check" CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "media_renditions_size_check" CHECK ("byte_size" > 0 AND "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000);

-- Grants: inserted and read, never updated or deleted by the application (a later cleanup of
-- unused pictures would add DELETE with its own migration).
GRANT SELECT, INSERT ON TABLE "blog"."media" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "blog"."media_renditions" TO "mondapac_app";
