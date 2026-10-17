-- Certification slice 7, admin review of seller certificates (data design 3.10, 3.16a, 3.17, 6.1,
-- section 8): the review checks, the location and scope readings, the issuer confirmations and the
-- two keyed indexes of the duplicate hint. The decisions and the status history already exist
-- (migrations 1 and 3); this migration adds their writers' tables and grants.

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "certification"."submission_review_checks" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "check_code" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submission_review_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."submission_scope_readings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "location_ciphertext" TEXT NOT NULL,
    "scope_ciphertext" TEXT NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submission_scope_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."seller_issuer_confirmations" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "issuer_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "confirmed_on" DATE NOT NULL,
    "reference_ciphertext" TEXT NOT NULL,
    "confirms_number" BOOLEAN NOT NULL,
    "confirms_holder" BOOLEAN NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_issuer_confirmations_pkey" PRIMARY KEY ("market_id","submission_id")
);

-- CreateTable
CREATE TABLE "certification"."certificate_number_index" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "index_hmac" BYTEA NOT NULL,

    CONSTRAINT "certificate_number_index_pkey" PRIMARY KEY ("market_id","submission_id")
);

-- CreateTable
CREATE TABLE "certification"."document_index" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "index_hmac" BYTEA NOT NULL,

    CONSTRAINT "document_index_pkey" PRIMARY KEY ("market_id","document_id")
);

-- CreateIndex
CREATE INDEX "submission_review_checks_market_id_submission_id_check_code_idx" ON "certification"."submission_review_checks"("market_id", "submission_id", "check_code", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "submission_review_checks_market_id_id_key" ON "certification"."submission_review_checks"("market_id", "id");

-- CreateIndex
CREATE INDEX "submission_scope_readings_market_id_submission_id_recorded__idx" ON "certification"."submission_scope_readings"("market_id", "submission_id", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "submission_scope_readings_market_id_id_key" ON "certification"."submission_scope_readings"("market_id", "id");

-- CreateIndex
CREATE INDEX "certificate_number_index_market_id_index_hmac_idx" ON "certification"."certificate_number_index"("market_id", "index_hmac");

-- CreateIndex
CREATE INDEX "certificate_number_index_market_id_seller_id_idx" ON "certification"."certificate_number_index"("market_id", "seller_id");

-- CreateIndex
CREATE INDEX "document_index_market_id_index_hmac_idx" ON "certification"."document_index"("market_id", "index_hmac");

-- CreateIndex
CREATE INDEX "document_index_market_id_seller_id_idx" ON "certification"."document_index"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_cert_submissions_id_seller_key" ON "certification"."seller_certification_submissions"("market_id", "id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_documents_market_id_id_owner_seller_id_key" ON "certification"."uploaded_documents"("market_id", "id", "owner_seller_id");

-- AddForeignKey
ALTER TABLE "certification"."submission_review_checks" ADD CONSTRAINT "submission_review_checks_market_id_submission_id_fkey" FOREIGN KEY ("market_id", "submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."submission_scope_readings" ADD CONSTRAINT "submission_scope_readings_market_id_submission_id_fkey" FOREIGN KEY ("market_id", "submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_issuer_confirmations" ADD CONSTRAINT "seller_issuer_confirmations_market_id_submission_id_issuer_fkey" FOREIGN KEY ("market_id", "submission_id", "issuer_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id", "issuer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_issuer_confirmations" ADD CONSTRAINT "seller_issuer_confirmations_market_id_issuer_id_channel_id_fkey" FOREIGN KEY ("market_id", "issuer_id", "channel_id") REFERENCES "certification"."issuer_contact_channels"("market_id", "issuer_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."certificate_number_index" ADD CONSTRAINT "certificate_number_index_market_id_submission_id_seller_id_fkey" FOREIGN KEY ("market_id", "submission_id", "seller_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."document_index" ADD CONSTRAINT "document_index_market_id_document_id_seller_id_fkey" FOREIGN KEY ("market_id", "document_id", "seller_id") REFERENCES "certification"."uploaded_documents"("market_id", "id", "owner_seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written CHECKs (data design 3.10, 3.16a, 3.17, 4.4).
ALTER TABLE "certification"."submission_review_checks"
  ADD CONSTRAINT "submission_review_checks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "submission_review_checks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "submission_review_checks_check_code_check" CHECK ("check_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "submission_review_checks_result_check" CHECK (
    "result" IN ('done', 'problem', 'not-applicable'));

ALTER TABLE "certification"."submission_scope_readings"
  ADD CONSTRAINT "submission_scope_readings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "submission_scope_readings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "submission_scope_readings_location_ciphertext_check" CHECK (
    "location_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("location_ciphertext") BETWEEN 41 AND 2048),
  ADD CONSTRAINT "submission_scope_readings_scope_ciphertext_check" CHECK (
    "scope_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("scope_ciphertext") BETWEEN 41 AND 8192);

ALTER TABLE "certification"."seller_issuer_confirmations"
  ADD CONSTRAINT "seller_issuer_confirmations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_issuer_confirmations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_issuer_confirmations_reference_ciphertext_check" CHECK (
    "reference_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("reference_ciphertext") BETWEEN 41 AND 4096),
  -- A row exists only for a full confirmation, so `verifiedWithIssuer` is "a row exists".
  ADD CONSTRAINT "seller_issuer_confirmations_both_ticks_check" CHECK (
    "confirms_number" AND "confirms_holder");

ALTER TABLE "certification"."certificate_number_index"
  ADD CONSTRAINT "certificate_number_index_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "certificate_number_index_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "certificate_number_index_index_hmac_check" CHECK (octet_length("index_hmac") = 32);

ALTER TABLE "certification"."document_index"
  ADD CONSTRAINT "document_index_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "document_index_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "document_index_index_hmac_check" CHECK (octet_length("index_hmac") = 32);

-- Hand-written partial index (invisible to Prisma; data design 7.1 A5): the reviewer queue holds
-- only the certificates that have a pending submission.
CREATE INDEX "seller_certifications_market_id_pending_idx"
  ON "certification"."seller_certifications" ("market_id", "status_changed_at", "id")
  WHERE "pending_submission_id" IS NOT NULL;

-- Append-only tables (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "submission_review_checks_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."submission_review_checks"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "submission_review_checks_no_truncate"
  BEFORE TRUNCATE ON "certification"."submission_review_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "submission_scope_readings_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."submission_scope_readings"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "submission_scope_readings_no_truncate"
  BEFORE TRUNCATE ON "certification"."submission_scope_readings"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_issuer_confirmations_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."seller_issuer_confirmations"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_issuer_confirmations_no_truncate"
  BEFORE TRUNCATE ON "certification"."seller_issuer_confirmations"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. The three review tables
-- are insert-only; the two keyed indexes also get DELETE, the only DELETE grant on them (L4: the
-- erasure handler removes a seller's rows; a draft file's row goes with the file).
GRANT SELECT, INSERT ON TABLE "certification"."submission_review_checks" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."submission_scope_readings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."seller_issuer_confirmations" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."certificate_number_index" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."document_index" TO "mondapac_app";
