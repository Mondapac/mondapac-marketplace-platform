-- Certification slice 15 part 2, the documents and review checks of a manufacturer certificate
-- (data design 3.15, 3.16; D 3.4 rows 2 and 3; design 14.11 "Split"): the draft's files, the files
-- a revision holds (sealed at submission) and the review checks recorded on a pending revision.
-- An admin file is an `uploaded_documents` row of purpose `product-certificate` with no owner
-- (the CHECK of migration 20261017090000), encrypted under the Market's platform subject; the
-- links name its type, so a file of another type cannot be linked. The intake, the storage and
-- the review-check shape are the seller path's.

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "certification"."product_certification_draft_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "product_certification_draft_documents_pkey" PRIMARY KEY ("market_id","product_certification_id","document_id")
);

-- CreateTable
CREATE TABLE "certification"."product_revision_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "product_revision_documents_pkey" PRIMARY KEY ("market_id","revision_id","document_id")
);

-- CreateTable
CREATE TABLE "certification"."product_revision_review_checks" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "check_code" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_revision_review_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_draft_documents_document_key" ON "certification"."product_certification_draft_documents"("market_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_draft_documents_position_key" ON "certification"."product_certification_draft_documents"("market_id", "product_certification_id", "position");

-- CreateIndex
CREATE INDEX "product_revision_documents_market_id_document_id_idx" ON "certification"."product_revision_documents"("market_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_documents_market_id_revision_id_position_key" ON "certification"."product_revision_documents"("market_id", "revision_id", "position");

-- CreateIndex
CREATE INDEX "product_revision_review_checks_lookup_idx" ON "certification"."product_revision_review_checks"("market_id", "revision_id", "check_code", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_review_checks_market_id_id_key" ON "certification"."product_revision_review_checks"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_documents_market_id_id_type_id_key" ON "certification"."uploaded_documents"("market_id", "id", "type_id");

-- AddForeignKey
ALTER TABLE "certification"."product_certification_draft_documents" ADD CONSTRAINT "product_certification_draft_documents_certificate_fkey" FOREIGN KEY ("market_id", "product_certification_id", "type_id") REFERENCES "certification"."product_certifications"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_draft_documents" ADD CONSTRAINT "product_certification_draft_documents_document_fkey" FOREIGN KEY ("market_id", "document_id", "type_id") REFERENCES "certification"."uploaded_documents"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_documents" ADD CONSTRAINT "product_revision_documents_revision_fkey" FOREIGN KEY ("market_id", "revision_id", "type_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_documents" ADD CONSTRAINT "product_revision_documents_document_fkey" FOREIGN KEY ("market_id", "document_id", "type_id") REFERENCES "certification"."uploaded_documents"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_review_checks" ADD CONSTRAINT "product_revision_review_checks_revision_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written CHECKs (data design 3.10, 3.11, 4.4; S4, S8).
ALTER TABLE "certification"."product_certification_draft_documents"
  ADD CONSTRAINT "product_certification_draft_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certification_draft_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_certification_draft_documents_position_check" CHECK ("position" >= 1);

ALTER TABLE "certification"."product_revision_documents"
  ADD CONSTRAINT "product_revision_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_documents_position_check" CHECK ("position" >= 1);

ALTER TABLE "certification"."product_revision_review_checks"
  ADD CONSTRAINT "product_revision_review_checks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_review_checks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_review_checks_check_code_check" CHECK ("check_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "product_revision_review_checks_result_check" CHECK (
    "result" IN ('done', 'problem', 'not-applicable'));

-- Only a clean file of the product-certificate purpose joins a manufacturer draft or revision
-- (AC 21), as the seller links (migration 20261017090000): no row lock, the link's own foreign
-- key takes FOR KEY SHARE on the document row. The purpose implies no owner (the CHECK pair).
CREATE FUNCTION "certification"."product_document_link_clean"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "certification"."uploaded_documents"
    WHERE "market_id" = NEW."market_id" AND "id" = NEW."document_id" AND "state" = 'clean'
      AND "purpose" = 'product-certificate'
  ) THEN
    RAISE EXCEPTION 'certification.%: only a clean product-certificate document can be linked', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "product_certification_draft_documents_clean" BEFORE INSERT
  ON "certification"."product_certification_draft_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."product_document_link_clean"();
CREATE TRIGGER "product_revision_documents_clean" BEFORE INSERT
  ON "certification"."product_revision_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."product_document_link_clean"();

-- Append-only tables (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "product_revision_documents_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_revision_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_documents_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_revision_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_review_checks_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_revision_review_checks"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_review_checks_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_revision_review_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. The draft's files are
-- added and removed (SELECT, INSERT, DELETE, no UPDATE); a revision's files and its checks are
-- insert-only.
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_documents" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_revision_documents" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_revision_review_checks" TO "mondapac_app";
