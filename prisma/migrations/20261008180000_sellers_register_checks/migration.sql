-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable (slice 4a, data design 3.4): the latest register result of one file and one
-- identifier value. "Not performed" is the absence of a row.
CREATE TABLE "sellers"."register_checks" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "identifier_index" BYTEA NOT NULL,
    "outcome" TEXT NOT NULL,
    "mismatches" TEXT[],
    "definite_negative_at" TIMESTAMPTZ(6),
    "compared_values_ciphertext" TEXT,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "checked_by_kind" TEXT NOT NULL,
    "checked_by_account_id" UUID,

    CONSTRAINT "register_checks_pkey" PRIMARY KEY ("market_id","seller_id","identifier_index")
);

-- AddForeignKey
ALTER TABLE "sellers"."register_checks" ADD CONSTRAINT "register_checks_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/sellers.md 2 (C1, C6), 3.4, 4.5. A new
-- table, so nothing here is NOT VALID. The mismatch list is NOT NULL here because Prisma does
-- not emit it for a scalar list (the application always writes an array, empty for none).
ALTER TABLE "sellers"."register_checks"
  ALTER COLUMN "mismatches" SET NOT NULL;

ALTER TABLE "sellers"."register_checks"
  ADD CONSTRAINT "register_checks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "register_checks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "register_checks_identifier_index_check" CHECK (octet_length("identifier_index") = 32),
  ADD CONSTRAINT "register_checks_outcome_check" CHECK (
    "outcome" IN ('active', 'not-found', 'cancelled', 'unavailable')),
  ADD CONSTRAINT "register_checks_mismatches_check" CHECK (
    "mismatches" <@ ARRAY['business-name', 'indirect-tax-registration', 'postcode']::text[]
    AND (cardinality("mismatches") = 0 OR "outcome" = 'active')),
  -- A definite negative carries its mark (the sticky rule reads it, AC 31); an active answer
  -- carries none (a successful lookup replaces the negative, D 3.4).
  ADD CONSTRAINT "register_checks_definite_negative_check" CHECK (
    ("outcome" NOT IN ('not-found', 'cancelled') OR "definite_negative_at" IS NOT NULL)
    AND ("outcome" <> 'active' OR "definite_negative_at" IS NULL)),
  -- The register's values stay out until the agreement allows them (D 7.7): the column is NULL
  -- in slice 4a. Bound by the rule of 4.5: a business name of 200 characters and a postcode in a
  -- JSON wrapper, at most 4 bytes a character, rounded up to the next power of two.
  ADD CONSTRAINT "register_checks_compared_values_ciphertext_check" CHECK (
    "compared_values_ciphertext" IS NULL OR (
      "compared_values_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
      AND char_length("compared_values_ciphertext") BETWEEN 41 AND 2048)),
  ADD CONSTRAINT "register_checks_checked_by_kind_check" CHECK (
    "checked_by_kind" IN ('seller', 'reviewer', 'job')),
  ADD CONSTRAINT "register_checks_checked_by_account_id_check" CHECK (
    ("checked_by_kind" = 'job') = ("checked_by_account_id" IS NULL));

-- Grants (database-designer): docs/design/data/sellers.md section 8, to mondapac_app only. The
-- latest result per value is written and rewritten; DELETE arrives with the purge of slice 18.
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."register_checks" TO "mondapac_app";
