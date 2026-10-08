-- Reverses 20261008130000_sellers_file_details (docs/design/data/sellers.md 9.4): the grants
-- first, in reverse order; then the index and the constraints added to the existing table
-- seller_files; then the new tables (their CHECKs, keys and the partial unique go with them;
-- the shop_slugs trigger and its function are dropped explicitly first);
-- then the columns added to seller_files. For an empty or development database only: it drops
-- the columns and their data.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "sellers"."rate_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "retired_at", "ever_public", "version") ON TABLE "sellers"."shop_slugs" FROM "mondapac_app";
DROP INDEX "sellers"."seller_files_market_id_store_name_key_idx";
ALTER TABLE "sellers"."seller_files"
  DROP CONSTRAINT "seller_files_timezone_default_check",
  DROP CONSTRAINT "seller_files_timezone_address_check",
  DROP CONSTRAINT "seller_files_timezone_set_check",
  DROP CONSTRAINT "seller_files_timezone_source_check",
  DROP CONSTRAINT "seller_files_address_timezone_check",
  DROP CONSTRAINT "seller_files_operating_timezone_check",
  DROP CONSTRAINT "seller_files_service_area_code_check",
  DROP CONSTRAINT "seller_files_registered_address_ciphertext_check",
  DROP CONSTRAINT "seller_files_address_ciphertext_check",
  DROP CONSTRAINT "seller_files_contact_email_ciphertext_check",
  DROP CONSTRAINT "seller_files_phone_ciphertext_check",
  DROP CONSTRAINT "seller_files_business_name_ciphertext_check",
  DROP CONSTRAINT "seller_files_store_name_key_check",
  DROP CONSTRAINT "seller_files_store_name_key_pair_check",
  DROP CONSTRAINT "seller_files_store_name_check";
DROP TABLE "sellers"."rate_counters";
DROP TRIGGER "shop_slugs_one_way" ON "sellers"."shop_slugs";
DROP FUNCTION "sellers"."shop_slugs_guard_update"();
DROP TABLE "sellers"."shop_slugs";
ALTER TABLE "sellers"."seller_files"
  DROP COLUMN "timezone_source",
  DROP COLUMN "store_name_key",
  DROP COLUMN "store_name",
  DROP COLUMN "service_area_code",
  DROP COLUMN "registered_address_ciphertext",
  DROP COLUMN "phone_ciphertext",
  DROP COLUMN "operating_timezone",
  DROP COLUMN "contact_email_ciphertext",
  DROP COLUMN "business_name_ciphertext",
  DROP COLUMN "address_timezone",
  DROP COLUMN "address_ciphertext";
