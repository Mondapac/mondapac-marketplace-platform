-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable (nullable, no default: a catalog change, no rewrite; 9.3). The business identifier
-- of the draft (3.1): its scheme (clear), the normalised value (ciphertext under the seller's
-- key) and the keyed index (S5, 4.4).
ALTER TABLE "sellers"."seller_files" ADD COLUMN     "identifier_ciphertext" TEXT,
ADD COLUMN     "identifier_index" BYTEA,
ADD COLUMN     "identifier_scheme" TEXT;

-- CreateTable
CREATE TABLE "sellers"."tax_registration_periods" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "registered_for_indirect_tax" BOOLEAN NOT NULL,
    "effective_from_local" DATE NOT NULL,
    "effective_zone" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "recorded_by_kind" TEXT NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_registration_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_registration_periods_market_id_seller_id_valid_from_idx" ON "sellers"."tax_registration_periods"("market_id", "seller_id", "valid_from");

-- AddForeignKey
ALTER TABLE "sellers"."tax_registration_periods" ADD CONSTRAINT "tax_registration_periods_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_tax_profiles"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/sellers.md 3.1, 4.5, 9.3. CHECKs on the
-- existing table are added NOT VALID and then validated; the new columns are NULL in every
-- existing row, so validation finds nothing. The ciphertext bound: a normalised identifier is at
-- most 64 characters (the application's input bound) of at most 4 bytes, so at most 382
-- characters in the v1 envelope, rounded up to 512 as the phone column is (4.5).
ALTER TABLE "sellers"."seller_files"
  ADD CONSTRAINT "seller_files_identifier_scheme_check" CHECK (
    "identifier_scheme" ~ '^[a-z][a-z0-9-]{0,31}$') NOT VALID,
  ADD CONSTRAINT "seller_files_identifier_ciphertext_check" CHECK (
    "identifier_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("identifier_ciphertext") BETWEEN 41 AND 512) NOT VALID,
  ADD CONSTRAINT "seller_files_identifier_index_check" CHECK (
    octet_length("identifier_index") = 32) NOT VALID,
  ADD CONSTRAINT "seller_files_identifier_set_check" CHECK (
    ("identifier_scheme" IS NULL) = ("identifier_ciphertext" IS NULL)
    AND ("identifier_ciphertext" IS NULL) = ("identifier_index" IS NULL)) NOT VALID;
ALTER TABLE "sellers"."seller_files"
  VALIDATE CONSTRAINT "seller_files_identifier_scheme_check",
  VALIDATE CONSTRAINT "seller_files_identifier_ciphertext_check",
  VALIDATE CONSTRAINT "seller_files_identifier_index_check",
  VALIDATE CONSTRAINT "seller_files_identifier_set_check";

-- Hand-written: the partial index of the exact search by identifier (A8, 9.5), invisible to
-- Prisma and checked by the partial-index catalog test. Plain CREATE INDEX: no deployed
-- environment holds rows yet (9.3).
CREATE INDEX "seller_files_market_id_identifier_index_idx" ON "sellers"."seller_files" ("market_id", "identifier_index") WHERE "identifier_index" IS NOT NULL;

-- Hand-written (database-designer): docs/design/data/sellers.md 2 (C1), 3.7. A new table, so
-- nothing here is NOT VALID.
ALTER TABLE "sellers"."tax_registration_periods"
  ADD CONSTRAINT "tax_registration_periods_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "tax_registration_periods_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "tax_registration_periods_effective_zone_check" CHECK (
    "effective_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("effective_zone") <= 64),
  ADD CONSTRAINT "tax_registration_periods_valid_to_check" CHECK (
    "valid_to" IS NULL OR "valid_to" > "valid_from"),
  ADD CONSTRAINT "tax_registration_periods_recorded_by_kind_check" CHECK (
    "recorded_by_kind" IN ('seller', 'admin'));

-- Hand-written: no two periods of one seller overlap (ADR-0009 V2; sellers design 2.4 rule 4).
-- Half-open ranges: a period that ends at the instant the next one starts is accepted. The
-- equality on market_id and seller_id inside a GiST index needs btree_gist (9.2), found by its
-- default operator class, so "extensions" need not be on any search_path.
ALTER TABLE "sellers"."tax_registration_periods"
  ADD CONSTRAINT "tax_registration_periods_no_overlap_excl" EXCLUDE USING gist (
    "market_id" WITH =, "seller_id" WITH =,
    tstzrange("valid_from", "valid_to", '[)') WITH &&);

-- Grants (database-designer): docs/design/data/sellers.md section 8, to mondapac_app only. A
-- period is only inserted, closed (valid_to) or, while it has not started, deleted (3.7, Q-M13).
GRANT SELECT, INSERT, UPDATE ("valid_to"), DELETE ON TABLE "sellers"."tax_registration_periods" TO "mondapac_app";
