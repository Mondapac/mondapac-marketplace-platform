-- AlterTable
ALTER TABLE "sellers"."store_profiles" ADD COLUMN     "published_revision_id" UUID;

-- CreateTable
CREATE TABLE "sellers"."store_profile_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "content_ciphertext" TEXT NOT NULL,
    "content_schema_version" SMALLINT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "author_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_profile_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sellers"."store_images" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "uploader_account_id" UUID NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_images_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "sellers"."store_image_renditions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "image_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "pixel_width" INTEGER NOT NULL,
    "pixel_height" INTEGER NOT NULL,

    CONSTRAINT "store_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_profile_revisions_market_id_seller_id_revision_no_key" ON "sellers"."store_profile_revisions"("market_id", "seller_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "store_profile_revisions_market_id_seller_id_id_key" ON "sellers"."store_profile_revisions"("market_id", "seller_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_images_market_id_seller_id_kind_key" ON "sellers"."store_images"("market_id", "seller_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "store_images_market_id_id_seller_id_key" ON "sellers"."store_images"("market_id", "id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_image_renditions_market_id_object_key_key" ON "sellers"."store_image_renditions"("market_id", "object_key");

-- AddForeignKey
ALTER TABLE "sellers"."store_profiles" ADD CONSTRAINT "store_profiles_market_id_seller_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "published_revision_id") REFERENCES "sellers"."store_profile_revisions"("market_id", "seller_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."store_profile_revisions" ADD CONSTRAINT "store_profile_revisions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."store_profiles"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."store_images" ADD CONSTRAINT "store_images_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."store_profiles"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."store_image_renditions" ADD CONSTRAINT "store_image_renditions_market_id_image_id_seller_id_fkey" FOREIGN KEY ("market_id", "image_id", "seller_id") REFERENCES "sellers"."store_images"("market_id", "id", "seller_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Sellers slice 12 part 2 (sellers design 3.7, 8.1; data design 3.8): the revisions of the public
-- store profile texts, the published pointer on `store_profiles`, and the current logo and banner
-- of a store. Hand-written below: the CHECKs and the grants. The new tables are empty, and the
-- pointer column is nullable without a default (a catalog change, no rewrite); nothing is NOT VALID.
-- No backfill: a store profile with no pointer simply has no About text.

ALTER TABLE "sellers"."store_profile_revisions"
  ADD CONSTRAINT "store_profile_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_profile_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "store_profile_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  -- The ciphertext bound: About text of at most 2000 characters (4 bytes each) in each locale of
  -- the Market (a handful at most) and the JSON around it come to about 40,000 plaintext bytes,
  -- so about 53,500 characters in the v1 envelope; rounded up to 65536.
  ADD CONSTRAINT "store_profile_revisions_content_ciphertext_check" CHECK (
    "content_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("content_ciphertext") BETWEEN 41 AND 65536),
  ADD CONSTRAINT "store_profile_revisions_content_schema_version_check" CHECK (
    "content_schema_version" >= 1),
  -- ContentHash (platform-audit 6.3): the HMAC kind only, because the content is personal.
  ADD CONSTRAINT "store_profile_revisions_content_hash_check" CHECK (
    "content_hash" ~ '^hmac-sha256:[0-9a-f]{64}$');

ALTER TABLE "sellers"."store_images"
  ADD CONSTRAINT "store_images_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_images_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "store_images_kind_check" CHECK ("kind" IN ('logo', 'banner')),
  ADD CONSTRAINT "store_images_pixels_check" CHECK (
    "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000),
  ADD CONSTRAINT "store_images_byte_size_check" CHECK ("byte_size" > 0);

ALTER TABLE "sellers"."store_image_renditions"
  ADD CONSTRAINT "store_image_renditions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_image_renditions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "store_image_renditions_size_code_check" CHECK ("size_code" IN ('small', 'large')),
  -- The key is built by code and starts with the seller id, so a key never names another seller's folder.
  ADD CONSTRAINT "store_image_renditions_object_key_check" CHECK (
    "object_key" LIKE "seller_id"::text || '/store-images/%'),
  ADD CONSTRAINT "store_image_renditions_sha256_check" CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "store_image_renditions_size_check" CHECK (
    "byte_size" > 0 AND "pixel_width" BETWEEN 1 AND 12000 AND "pixel_height" BETWEEN 1 AND 12000);

-- Grants (data design section 8 pattern, to mondapac_app only). A revision is insert-only: no
-- UPDATE and no DELETE, so its ciphertext and hash can never change by privilege. The current
-- image of a kind is replaced by deleting its row (the renditions go by the foreign key cascade,
-- which needs no grant on the child) and inserting the new one in the same unit. UPDATE on
-- store_profiles is already granted (the pointer and the minimum order live there).
GRANT SELECT, INSERT ON TABLE "sellers"."store_profile_revisions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "sellers"."store_images" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "sellers"."store_image_renditions" TO "mondapac_app";

-- Hassan H2: the pictures have their own rate counters (10 per minute and 100 per 24 h per
-- account, one pair shared by saves and removals). The kinds are a closed CHECK list (data design
-- 3.11), so the constraint of the file-details migration is replaced by the same list plus the two
-- new kinds. rate_counters is small and pruned, so the full check is cheap.
ALTER TABLE "sellers"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "sellers"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'slug-check.account.minute', 'slug-check.account.day',
    'save.account.minute', 'save.account.day',
    'store-image.account.minute', 'store-image.account.day',
    'lookup.account', 'lookup.origin', 'lookup.market', 'lookup.admin',
    'submit.file', 'withdraw.file', 'bulk.admin',
    'reviewer-notice.seller', 'reviewer-notice.market'));
