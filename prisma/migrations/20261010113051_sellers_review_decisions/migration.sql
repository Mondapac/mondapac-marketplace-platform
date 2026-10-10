-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Slice 7a-decide (docs/design/data/sellers.md 3.1, 3.3, 3.6, 3.13, 9.1 row 9): the decision
-- intent and the public store name on seller_files (nullable, no default: catalog changes, no
-- rewrite); the review checks, the identifier claims and the admin flags.
-- AlterTable
ALTER TABLE "sellers"."seller_files" ADD COLUMN     "decision_attempt_id" UUID,
ADD COLUMN     "decision_intent" TEXT,
ADD COLUMN     "decision_intent_since" TIMESTAMPTZ(6),
ADD COLUMN     "decision_revision_id" UUID,
ADD COLUMN     "public_store_name" TEXT;

-- CreateTable
CREATE TABLE "sellers"."review_checks" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "check_code" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "observed_register_outcome" TEXT,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_checks_pkey" PRIMARY KEY ("market_id","revision_id","check_code")
);

-- CreateTable
CREATE TABLE "sellers"."identifier_claims" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "identifier_index" BYTEA NOT NULL,
    "seller_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "identifier_claims_pkey" PRIMARY KEY ("market_id","identifier_index")
);

-- CreateTable
CREATE TABLE "sellers"."admin_flags" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL,
    "cleared_at" TIMESTAMPTZ(6),
    "cleared_by_account_id" UUID,

    CONSTRAINT "admin_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identifier_claims_market_id_seller_id_key" ON "sellers"."identifier_claims"("market_id", "seller_id");

-- AddForeignKey
ALTER TABLE "sellers"."seller_files" ADD CONSTRAINT "seller_files_market_id_seller_id_decision_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "decision_revision_id") REFERENCES "sellers"."business_file_revisions"("market_id", "seller_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."review_checks" ADD CONSTRAINT "review_checks_market_id_seller_id_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "revision_id") REFERENCES "sellers"."business_file_revisions"("market_id", "seller_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."identifier_claims" ADD CONSTRAINT "identifier_claims_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."identifier_claims" ADD CONSTRAINT "identifier_claims_market_id_seller_id_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "revision_id") REFERENCES "sellers"."business_file_revisions"("market_id", "seller_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."admin_flags" ADD CONSTRAINT "admin_flags_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/sellers.md 3.1. seller_files is not new, so
-- each CHECK is added NOT VALID and then validated (9.3); every existing row has NULL in every new
-- column and no approved pointer (nothing moved it before this slice), so each validates.
ALTER TABLE "sellers"."seller_files"
  ADD CONSTRAINT "seller_files_public_store_name_check" CHECK (
    ("approved_revision_id" IS NULL) = ("public_store_name" IS NULL)
    AND ("public_store_name" IS NULL OR (
      char_length("public_store_name") BETWEEN 1 AND 100
      AND "public_store_name" = btrim("public_store_name")
      AND "public_store_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'))) NOT VALID,
  ADD CONSTRAINT "seller_files_decision_intent_check" CHECK (
    "decision_intent" IN ('approve-requested', 'reject-requested', 'reapply-requested')) NOT VALID,
  ADD CONSTRAINT "seller_files_decision_intent_set_check" CHECK (
    ("decision_intent" IS NULL) = ("decision_attempt_id" IS NULL)
    AND ("decision_intent" IS NULL) = ("decision_revision_id" IS NULL)
    AND ("decision_intent" IS NULL) = ("decision_intent_since" IS NULL)) NOT VALID;
ALTER TABLE "sellers"."seller_files" VALIDATE CONSTRAINT "seller_files_public_store_name_check";
ALTER TABLE "sellers"."seller_files" VALIDATE CONSTRAINT "seller_files_decision_intent_check";
ALTER TABLE "sellers"."seller_files" VALIDATE CONSTRAINT "seller_files_decision_intent_set_check";

-- review_checks (3.3): a new table, so nothing here is NOT VALID.
ALTER TABLE "sellers"."review_checks"
  ADD CONSTRAINT "review_checks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "review_checks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "review_checks_check_code_check" CHECK ("check_code" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "review_checks_result_check" CHECK (
    "result" IN ('done', 'not-applicable', 'not-done')),
  ADD CONSTRAINT "review_checks_observed_register_outcome_check" CHECK (
    "observed_register_outcome" IN ('active', 'not-found', 'cancelled')),
  ADD CONSTRAINT "review_checks_manual_register_check_check" CHECK (
    ("check_code" = 'manual-register-check') = ("observed_register_outcome" IS NOT NULL));

-- identifier_claims (3.6).
ALTER TABLE "sellers"."identifier_claims"
  ADD CONSTRAINT "identifier_claims_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "identifier_claims_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "identifier_claims_identifier_index_check" CHECK (octet_length("identifier_index") = 32),
  ADD CONSTRAINT "identifier_claims_version_check" CHECK ("version" >= 1);

-- admin_flags (3.13).
ALTER TABLE "sellers"."admin_flags"
  ADD CONSTRAINT "admin_flags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "admin_flags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "admin_flags_code_check" CHECK ("code" IN ('identifier-claim-conflict')),
  ADD CONSTRAINT "admin_flags_cleared_check" CHECK (
    ("cleared_at" IS NULL) = ("cleared_by_account_id" IS NULL));

-- Hand-written: partial indexes (9.5), invisible to Prisma and checked by the partial-index
-- catalog test. A11: the reconciliation job reads the few in-flight intents by age. 3.13: one open
-- flag per Market, seller and code, and the list filter's open flags.
CREATE INDEX "seller_files_market_id_decision_intent_since_idx" ON "sellers"."seller_files" ("market_id", "decision_intent_since") WHERE "decision_intent" IS NOT NULL;
CREATE UNIQUE INDEX "admin_flags_market_id_seller_id_code_open_key" ON "sellers"."admin_flags" ("market_id", "seller_id", "code") WHERE "cleared_at" IS NULL;
CREATE INDEX "admin_flags_market_id_raised_at_open_idx" ON "sellers"."admin_flags" ("market_id", "raised_at", "id") WHERE "cleared_at" IS NULL;

-- Grants (database-designer): docs/design/data/sellers.md section 8, to mondapac_app only.
-- review_checks: upserted while pending, removed only by the cascade of its revision. A claim is
-- never updated (a move is a delete plus an insert). A flag is raised and cleared, never rewritten.
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."review_checks" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "sellers"."identifier_claims" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("cleared_at", "cleared_by_account_id") ON TABLE "sellers"."admin_flags" TO "mondapac_app";
