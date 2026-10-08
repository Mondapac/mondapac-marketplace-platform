-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable (nullable, no default: a catalog change, no rewrite; 9.3). store_name_key is
-- COLLATE "C" by hand (S6; Prisma does not see a column collation, spike S1).
ALTER TABLE "sellers"."seller_files" ADD COLUMN     "address_ciphertext" TEXT,
ADD COLUMN     "address_timezone" TEXT,
ADD COLUMN     "business_name_ciphertext" TEXT,
ADD COLUMN     "contact_email_ciphertext" TEXT,
ADD COLUMN     "operating_timezone" TEXT,
ADD COLUMN     "phone_ciphertext" TEXT,
ADD COLUMN     "registered_address_ciphertext" TEXT,
ADD COLUMN     "service_area_code" TEXT,
ADD COLUMN     "store_name" TEXT,
ADD COLUMN     "store_name_key" TEXT COLLATE "C",
ADD COLUMN     "timezone_source" TEXT;

-- CreateTable (slug is COLLATE "C" by hand, S6).
CREATE TABLE "sellers"."shop_slugs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT COLLATE "C" NOT NULL,
    "seller_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "ever_public" BOOLEAN NOT NULL,
    "held_at" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shop_slugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sellers"."rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_slugs_market_id_slug_key" ON "sellers"."shop_slugs"("market_id", "slug");

-- CreateIndex (on an existing table; no deployed environment holds sellers rows, so not
-- CONCURRENTLY: 9.3)
CREATE INDEX "seller_files_market_id_store_name_key_idx" ON "sellers"."seller_files"("market_id", "store_name_key");

-- Hand-written (database-designer): docs/design/data/sellers.md sections 2 (C1, S1, S4, S6, S7,
-- S8), 3.1, 3.5 and 3.11. The seller_files CHECKs are on an existing table, but on columns this
-- migration adds (NULL in every row) and no deployed environment exists, so they are not NOT
-- VALID (9.3; as identity_seller_access_roles). Ciphertext bounds (S4, 4): the v1 envelope of
-- platform/subject-keys ("v1." + base64url of 12-byte nonce, body, 16-byte tag) of the Q-M11
-- plaintext limit at 4 UTF-8 bytes per character, rounded up to the next power of two:
-- business name 200 -> 1,107 -> 2048; phone 32 -> 211 -> 512; contact email 254 -> 1,395 ->
-- 2048; address JSON, at most 12 fields of 120 characters (address.format) -> about 8,400 ->
-- 16384.
ALTER TABLE "sellers"."seller_files"
  ADD CONSTRAINT "seller_files_store_name_check" CHECK (
    char_length("store_name") BETWEEN 1 AND 100
    AND "store_name" = btrim("store_name")
    AND "store_name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "seller_files_store_name_key_pair_check" CHECK (
    ("store_name" IS NULL) = ("store_name_key" IS NULL)),
  ADD CONSTRAINT "seller_files_store_name_key_check" CHECK (
    char_length("store_name_key") BETWEEN 1 AND 400
    AND "store_name_key" = btrim("store_name_key")
    AND "store_name_key" IS NFKC NORMALIZED
    AND "store_name_key" = lower("store_name_key" COLLATE "C")),
  ADD CONSTRAINT "seller_files_business_name_ciphertext_check" CHECK (
    char_length("business_name_ciphertext") BETWEEN 1 AND 2048),
  ADD CONSTRAINT "seller_files_phone_ciphertext_check" CHECK (
    char_length("phone_ciphertext") BETWEEN 1 AND 512),
  ADD CONSTRAINT "seller_files_contact_email_ciphertext_check" CHECK (
    char_length("contact_email_ciphertext") BETWEEN 1 AND 2048),
  ADD CONSTRAINT "seller_files_address_ciphertext_check" CHECK (
    char_length("address_ciphertext") BETWEEN 1 AND 16384),
  ADD CONSTRAINT "seller_files_registered_address_ciphertext_check" CHECK (
    char_length("registered_address_ciphertext") BETWEEN 1 AND 16384),
  ADD CONSTRAINT "seller_files_service_area_code_check" CHECK (
    "service_area_code" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "seller_files_operating_timezone_check" CHECK (
    "operating_timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("operating_timezone") <= 64),
  ADD CONSTRAINT "seller_files_address_timezone_check" CHECK (
    "address_timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("address_timezone") <= 64),
  ADD CONSTRAINT "seller_files_timezone_source_check" CHECK (
    "timezone_source" IN ('default', 'browser', 'location', 'seller', 'admin')),
  ADD CONSTRAINT "seller_files_timezone_set_check" CHECK (
    ("operating_timezone" IS NULL) = ("timezone_source" IS NULL)
    AND ("operating_timezone" IS NULL) = ("address_timezone" IS NULL)),
  ADD CONSTRAINT "seller_files_timezone_address_check" CHECK (
    "operating_timezone" IS NULL OR "address_ciphertext" IS NOT NULL),
  ADD CONSTRAINT "seller_files_timezone_default_check" CHECK (
    "timezone_source" <> 'default' OR "operating_timezone" = "address_timezone");

ALTER TABLE "sellers"."shop_slugs"
  ADD CONSTRAINT "shop_slugs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "shop_slugs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "shop_slugs_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 50),
  ADD CONSTRAINT "shop_slugs_state_check" CHECK ("state" IN ('held', 'retired')),
  ADD CONSTRAINT "shop_slugs_ever_public_check" CHECK ("state" = 'held' OR "ever_public"),
  ADD CONSTRAINT "shop_slugs_retired_at_check" CHECK (
    ("state" = 'retired') = ("retired_at" IS NOT NULL)
    AND ("retired_at" IS NULL OR "retired_at" >= "held_at")),
  ADD CONSTRAINT "shop_slugs_version_check" CHECK ("version" >= 1);

-- The kinds are the closed list of 3.11, the two reviewer-notice kinds (slice 5; Ali R-3)
-- included, so no later slice alters this CHECK.
ALTER TABLE "sellers"."rate_counters"
  ADD CONSTRAINT "rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'slug-check.account.minute', 'slug-check.account.day',
    'save.account.minute', 'save.account.day',
    'lookup.account', 'lookup.origin', 'lookup.market', 'lookup.admin',
    'submit.file', 'withdraw.file', 'bulk.admin',
    'reviewer-notice.seller', 'reviewer-notice.market')),
  ADD CONSTRAINT "rate_counters_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "rate_counters_count_check" CHECK ("count" >= 0);

-- Hand-written (database-designer): docs/design/data/sellers.md sections 3.5 and 9.5, one held
-- slug per seller. Invisible to Prisma; checked by the partial-index catalog test.
CREATE UNIQUE INDEX "shop_slugs_market_id_seller_id_held_key" ON "sellers"."shop_slugs" ("market_id", "seller_id") WHERE "state" = 'held';

-- Grants (database-designer): docs/design/data/sellers.md section 8. seller_files keeps its
-- table-level grant of slice 1. shop_slugs: the slug and its holder never change; DELETE
-- arrives in slice 5 (Q-M21). rate_counters: UPDATE also serves the guarded release of the
-- two reviewer-notice kinds (3.11); DELETE for the hourly purge.
GRANT SELECT, INSERT, UPDATE ("state", "retired_at", "ever_public", "version") ON TABLE "sellers"."shop_slugs" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sellers"."rate_counters" TO "mondapac_app";
