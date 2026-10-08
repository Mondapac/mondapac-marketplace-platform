-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable (slice 5, Hassan M1 residual; section 22): the file version the register comparison
-- read the draft at. NOT NULL for every row. Existing rows get 1 through a constant default (a
-- catalog change, no rewrite), and the default is dropped at once, so every later insert must
-- state the version it compared. A pre-existing row can never be "current": a result exists only
-- after an identifier save, so its file is at version 2 or more (section 22).
ALTER TABLE "sellers"."register_checks" ADD COLUMN     "compared_file_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sellers"."register_checks" ALTER COLUMN "compared_file_version" DROP DEFAULT;

-- AlterTable (nullable, no default: a catalog change, no rewrite; 9.3). The V1 pointer to the
-- live approved revision (3.1). Moved by slice 7a-decide only.
ALTER TABLE "sellers"."seller_files" ADD COLUMN     "approved_revision_id" UUID;

-- CreateTable
CREATE TABLE "sellers"."business_file_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_account_id" UUID NOT NULL,
    "content_ciphertext" TEXT NOT NULL,
    "content_schema_version" SMALLINT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "identifier_index" BYTEA,
    "operating_timezone" TEXT NOT NULL,
    "service_area_code" TEXT NOT NULL,
    "address_timezone" TEXT,
    "register_outcome" TEXT NOT NULL,
    "register_mismatches" TEXT[],
    "register_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,
    "identity_decision_id" UUID,
    "reject_reason_code" TEXT,
    "withdraw_cause" TEXT,
    "withdrawn_by_kind" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6),

    CONSTRAINT "business_file_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_revision_no_key" ON "sellers"."business_file_revisions"("market_id", "seller_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_id_key" ON "sellers"."business_file_revisions"("market_id", "seller_id", "id");

-- AddForeignKey
ALTER TABLE "sellers"."seller_files" ADD CONSTRAINT "seller_files_market_id_seller_id_approved_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "approved_revision_id") REFERENCES "sellers"."business_file_revisions"("market_id", "seller_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."business_file_revisions" ADD CONSTRAINT "business_file_revisions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/sellers.md 2 (C1, C6), 3.2, 4.5, 22. The
-- mismatch list is NOT NULL here because Prisma does not emit it for a scalar list (the
-- application always writes an array, empty for none).
ALTER TABLE "sellers"."business_file_revisions"
  ALTER COLUMN "register_mismatches" SET NOT NULL;

-- register_checks.compared_file_version (section 22; Hassan M1 residual). The table is not new,
-- so the CHECK is added NOT VALID and then validated (9.3); every row holds 1 at this point.
ALTER TABLE "sellers"."register_checks"
  ADD CONSTRAINT "register_checks_compared_file_version_check" CHECK (
    "compared_file_version" >= 1) NOT VALID;
ALTER TABLE "sellers"."register_checks"
  VALIDATE CONSTRAINT "register_checks_compared_file_version_check";

-- business_file_revisions: a new table, so nothing here is NOT VALID. The content ciphertext
-- bound (4.5 rule, section 22): a store name (100 characters), a business name (200), two
-- address objects, an identifier (64), a phone (32), a contact email (254) and the tax answer in
-- one JSON object come to at most about 16,000 plaintext bytes at 4 bytes a character, so about
-- 21,400 characters in the v1 envelope, rounded up to the next power of two, 32768.
ALTER TABLE "sellers"."business_file_revisions"
  ADD CONSTRAINT "business_file_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "business_file_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "business_file_revisions_kind_check" CHECK (
    "kind" IN ('onboarding', 'identity-change')),
  ADD CONSTRAINT "business_file_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "business_file_revisions_status_check" CHECK (
    "status" IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  ADD CONSTRAINT "business_file_revisions_author_kind_check" CHECK (
    "author_kind" IN ('seller', 'admin')),
  ADD CONSTRAINT "business_file_revisions_content_ciphertext_check" CHECK (
    "content_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("content_ciphertext") BETWEEN 41 AND 32768),
  ADD CONSTRAINT "business_file_revisions_content_schema_version_check" CHECK (
    "content_schema_version" >= 1),
  -- ContentHash (docs/design/domain/platform-audit.md 6.3): this column takes only the HMAC kind,
  -- because its content is personal (ADR-0009 decision 6).
  ADD CONSTRAINT "business_file_revisions_content_hash_check" CHECK (
    "content_hash" ~ '^hmac-sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "business_file_revisions_identifier_index_check" CHECK (
    octet_length("identifier_index") = 32),
  ADD CONSTRAINT "business_file_revisions_operating_timezone_check" CHECK (
    "operating_timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("operating_timezone") <= 64),
  ADD CONSTRAINT "business_file_revisions_address_timezone_check" CHECK (
    "address_timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("address_timezone") <= 64),
  ADD CONSTRAINT "business_file_revisions_service_area_code_check" CHECK (
    "service_area_code" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "business_file_revisions_register_outcome_check" CHECK (
    "register_outcome" IN ('not-performed', 'active', 'not-found', 'cancelled', 'unavailable')),
  ADD CONSTRAINT "business_file_revisions_register_mismatches_check" CHECK (
    "register_mismatches" <@ ARRAY['business-name', 'indirect-tax-registration', 'postcode']::text[]
    AND (cardinality("register_mismatches") = 0 OR "register_outcome" = 'active')),
  ADD CONSTRAINT "business_file_revisions_register_checked_at_check" CHECK (
    ("register_outcome" = 'not-performed') = ("register_checked_at" IS NULL)),
  -- Pending means unchanged since the submission (3.2 "equals created_at while pending").
  ADD CONSTRAINT "business_file_revisions_status_changed_at_check" CHECK (
    "status" <> 'pending' OR "status_changed_at" = "created_at"),
  ADD CONSTRAINT "business_file_revisions_decided_at_check" CHECK (
    ("status" IN ('approved', 'rejected', 'superseded')) = ("decided_at" IS NOT NULL)),
  -- Onboarding decisions are recorded by identity (3.2, D 3.1): only an identity change carries
  -- the deciding account here, and only an onboarding revision carries identity's decision id.
  ADD CONSTRAINT "business_file_revisions_decided_by_account_id_check" CHECK (
    "decided_by_account_id" IS NULL OR "kind" = 'identity-change'),
  ADD CONSTRAINT "business_file_revisions_identity_decision_id_check" CHECK (
    "identity_decision_id" IS NULL OR "kind" = 'onboarding'),
  ADD CONSTRAINT "business_file_revisions_reject_reason_code_check" CHECK (
    ("reject_reason_code" IS NOT NULL) = ("status" = 'rejected' AND "kind" = 'identity-change')
    AND ("reject_reason_code" IS NULL OR "reject_reason_code" ~ '^[a-z0-9][a-z0-9-]{0,63}$')),
  ADD CONSTRAINT "business_file_revisions_withdraw_cause_check" CHECK (
    "withdraw_cause" IN ('edited', 'cancelled', 'reapply-refused')),
  ADD CONSTRAINT "business_file_revisions_withdrawn_by_kind_check" CHECK (
    "withdrawn_by_kind" IN ('seller', 'admin')),
  ADD CONSTRAINT "business_file_revisions_withdrawn_check" CHECK (
    ("status" = 'withdrawn') = ("withdraw_cause" IS NOT NULL)
    AND ("withdraw_cause" IS NULL) = ("withdrawn_by_kind" IS NULL)
    AND ("withdraw_cause" IS NULL) = ("withdrawn_at" IS NULL));

-- Hand-written: partial indexes (9.5), invisible to Prisma and checked by the partial-index
-- catalog test. One pending revision per file, of either kind, and one live approved revision
-- (a backstop to the pointer); the reviewer queue reads pending revisions by kind and age.
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_pending_key" ON "sellers"."business_file_revisions" ("market_id", "seller_id") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_approved_key" ON "sellers"."business_file_revisions" ("market_id", "seller_id") WHERE "status" = 'approved';
CREATE INDEX "business_file_revisions_market_id_kind_created_at_pending_idx" ON "sellers"."business_file_revisions" ("market_id", "kind", "created_at", "id") WHERE "status" = 'pending';

-- Grants (database-designer): docs/design/data/sellers.md section 8, to mondapac_app only.
-- Content never changes by privilege (3.2): only the status columns can be updated, so
-- content_ciphertext, content_hash, identifier_index and the snapshot columns refuse with 42501.
-- DELETE arrives with the purge of slice 18. shop_slugs gets DELETE here (Q-M21, 9.1 row 6): the
-- first slice that holds a slug is the first that can release one.
GRANT SELECT, INSERT, UPDATE ("status", "status_changed_at", "decided_at", "decided_by_account_id", "identity_decision_id", "reject_reason_code", "withdraw_cause", "withdrawn_by_kind", "withdrawn_at") ON TABLE "sellers"."business_file_revisions" TO "mondapac_app";
GRANT DELETE ON TABLE "sellers"."shop_slugs" TO "mondapac_app";

-- Hand-written (database-designer, condition C1): a retired or ever-public slug outlives every
-- role's DELETE (docs/design/data/sellers.md 3.5). Only a held, never-public row can be released.
CREATE FUNCTION "sellers"."shop_slugs_guard_delete"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" = 'retired' OR OLD."ever_public" THEN
    RAISE EXCEPTION 'sellers.shop_slugs: a retired or ever-public slug is never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "shop_slugs_no_delete_public"
  BEFORE DELETE ON "sellers"."shop_slugs"
  FOR EACH ROW EXECUTE FUNCTION "sellers"."shop_slugs_guard_delete"();
