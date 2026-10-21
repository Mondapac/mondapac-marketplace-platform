-- Reverses 20261021183643_sellers_store_profile_content (sellers design 3.7; data design 3.8): the
-- grants first; then the pointer foreign key and column of store_profiles (the pointer names the
-- revisions); then the new tables, children first (their CHECKs, indexes and keys go with them).
-- For an empty or development database only: it drops every saved About text revision and every
-- stored logo and banner row (the image objects in storage are not touched by a migration).
REVOKE SELECT, INSERT ON TABLE "sellers"."store_image_renditions" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "sellers"."store_images" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "sellers"."store_profile_revisions" FROM "mondapac_app";
ALTER TABLE "sellers"."store_profiles" DROP CONSTRAINT "store_profiles_market_id_seller_id_published_revision_id_fkey";
DROP TABLE "sellers"."store_image_renditions";
DROP TABLE "sellers"."store_images";
DROP TABLE "sellers"."store_profile_revisions";
ALTER TABLE "sellers"."store_profiles" DROP COLUMN "published_revision_id";
