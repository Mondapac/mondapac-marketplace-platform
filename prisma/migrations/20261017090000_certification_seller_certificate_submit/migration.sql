-- Certification, the seller adds a certificate (data design 9.1 migrations 3 and 4 merged, simplified
-- the way the owner decided for the catalog photos: no scanner, no sandbox, no previews, no Object
-- Lock and no evidence bucket). `uploaded_documents` therefore has no evidence_key, retain_until or
-- promoted_at; the bytes stay in the one object store, encrypted per file. The draft columns, the
-- document links, the status history and the seller-side counters arrive with it.

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "certification"."seller_certifications" ADD COLUMN     "draft_certificate_number_ciphertext" TEXT,
ADD COLUMN     "draft_expiry_date" DATE,
ADD COLUMN     "draft_issue_date" DATE,
ADD COLUMN     "draft_issuer_id" UUID,
ADD COLUMN     "draft_self_declaration_note_ciphertext" TEXT,
ADD COLUMN     "draft_self_declared" BOOLEAN;

-- CreateTable
CREATE TABLE "certification"."uploaded_documents" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_seller_id" UUID,
    "purpose" TEXT NOT NULL,
    "type_id" UUID,
    "state" TEXT NOT NULL,
    "refusal_code" TEXT,
    "media_type" TEXT,
    "byte_size" BIGINT NOT NULL,
    "page_count" SMALLINT,
    "data_key_envelope" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "clean_sha256" BYTEA,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uploaded_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."seller_draft_quotas" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "draft_bytes" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_draft_quotas_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateTable
CREATE TABLE "certification"."rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- CreateTable
CREATE TABLE "certification"."seller_certification_draft_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_certification_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "seller_certification_draft_documents_pkey" PRIMARY KEY ("market_id","seller_certification_id","document_id")
);

-- CreateTable
CREATE TABLE "certification"."seller_submission_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "seller_submission_documents_pkey" PRIMARY KEY ("market_id","submission_id","document_id")
);

-- CreateTable
CREATE TABLE "certification"."seller_certification_history" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_certification_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "submission_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "reason_code" TEXT,
    "note_ciphertext" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_certification_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_certifications_market_id_seller_id_created_at_idx" ON "certification"."seller_certifications"("market_id", "seller_id", "created_at");

-- CreateIndex
CREATE INDEX "uploaded_documents_market_id_owner_seller_id_created_at_idx" ON "certification"."uploaded_documents"("market_id", "owner_seller_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_documents_market_id_id_key" ON "certification"."uploaded_documents"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_documents_market_id_id_type_id_owner_seller_id_key" ON "certification"."uploaded_documents"("market_id", "id", "type_id", "owner_seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_documents_market_id_object_key_key" ON "certification"."uploaded_documents"("market_id", "object_key");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_draft_documents_market_id_document_id_key" ON "certification"."seller_certification_draft_documents"("market_id", "document_id");

-- CreateIndex
CREATE INDEX "seller_submission_documents_market_id_document_id_idx" ON "certification"."seller_submission_documents"("market_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_submission_documents_market_id_submission_id_positio_key" ON "certification"."seller_submission_documents"("market_id", "submission_id", "position");

-- CreateIndex
CREATE INDEX "seller_certification_history_market_id_seller_certification_idx" ON "certification"."seller_certification_history"("market_id", "seller_certification_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_history_market_id_id_key" ON "certification"."seller_certification_history"("market_id", "id");

-- AddForeignKey (existing table: NOT VALID, then VALIDATE; data design 9.2)
ALTER TABLE "certification"."seller_certifications" ADD CONSTRAINT "seller_certifications_market_id_draft_issuer_id_type_id_fkey" FOREIGN KEY ("market_id", "draft_issuer_id", "type_id") REFERENCES "certification"."issuers"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "certification"."seller_certifications" VALIDATE CONSTRAINT "seller_certifications_market_id_draft_issuer_id_type_id_fkey";

-- AddForeignKey
ALTER TABLE "certification"."uploaded_documents" ADD CONSTRAINT "uploaded_documents_market_id_type_id_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_draft_documents" ADD CONSTRAINT "seller_certification_draft_documents_market_id_seller_cert_fkey" FOREIGN KEY ("market_id", "seller_certification_id", "type_id", "seller_id") REFERENCES "certification"."seller_certifications"("market_id", "id", "type_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_draft_documents" ADD CONSTRAINT "seller_certification_draft_documents_market_id_document_id_fkey" FOREIGN KEY ("market_id", "document_id", "type_id", "seller_id") REFERENCES "certification"."uploaded_documents"("market_id", "id", "type_id", "owner_seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_submission_documents" ADD CONSTRAINT "seller_submission_documents_market_id_submission_id_fkey" FOREIGN KEY ("market_id", "submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_submission_documents" ADD CONSTRAINT "seller_submission_documents_market_id_document_id_fkey" FOREIGN KEY ("market_id", "document_id") REFERENCES "certification"."uploaded_documents"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_history" ADD CONSTRAINT "seller_certification_history_certificate_fkey" FOREIGN KEY ("market_id", "seller_certification_id") REFERENCES "certification"."seller_certifications"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_history" ADD CONSTRAINT "seller_certification_history_submission_fkey" FOREIGN KEY ("market_id", "seller_certification_id", "submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "seller_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written CHECKs (data design 3.4, 3.9, 3.11 to 3.13, 4.4).
-- The draft columns of the existing root: NOT VALID, then VALIDATE (the columns are new, all NULL).
ALTER TABLE "certification"."seller_certifications"
  ADD CONSTRAINT "seller_certifications_draft_dates_check" CHECK (
    "draft_issue_date" IS NULL OR "draft_expiry_date" IS NULL OR "draft_issue_date" <= "draft_expiry_date") NOT VALID,
  ADD CONSTRAINT "seller_certifications_draft_cert_number_ciphertext_check" CHECK (
    "draft_certificate_number_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("draft_certificate_number_ciphertext") BETWEEN 41 AND 512) NOT VALID,
  ADD CONSTRAINT "seller_certifications_draft_note_ciphertext_check" CHECK (
    "draft_self_declaration_note_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("draft_self_declaration_note_ciphertext") BETWEEN 41 AND 8192) NOT VALID;
ALTER TABLE "certification"."seller_certifications"
  VALIDATE CONSTRAINT "seller_certifications_draft_dates_check",
  VALIDATE CONSTRAINT "seller_certifications_draft_cert_number_ciphertext_check",
  VALIDATE CONSTRAINT "seller_certifications_draft_note_ciphertext_check";

ALTER TABLE "certification"."uploaded_documents"
  ADD CONSTRAINT "uploaded_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "uploaded_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "uploaded_documents_purpose_check" CHECK (
    "purpose" IN ('seller-certificate', 'issuer-request', 'product-certificate')),
  ADD CONSTRAINT "uploaded_documents_owner_purpose_check" CHECK (
    ("owner_seller_id" IS NULL) = ("purpose" = 'product-certificate')),
  ADD CONSTRAINT "uploaded_documents_state_check" CHECK (
    "state" IN ('received', 'scanning', 'clean', 'refused')),
  ADD CONSTRAINT "uploaded_documents_refusal_code_check" CHECK (
    "refusal_code" IN ('file.unsupported-type', 'file.too-large', 'file.unreadable',
      'file.too-many-pages', 'file.encrypted', 'file.active-content', 'file.malware',
      'file.scan-failed')),
  ADD CONSTRAINT "uploaded_documents_refusal_pair_check" CHECK (
    ("state" = 'refused') = ("refusal_code" IS NOT NULL)),
  ADD CONSTRAINT "uploaded_documents_media_type_check" CHECK (
    "media_type" IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf')),
  ADD CONSTRAINT "uploaded_documents_clean_media_type_check" CHECK (
    "state" <> 'clean' OR "media_type" IS NOT NULL),
  ADD CONSTRAINT "uploaded_documents_byte_size_check" CHECK ("byte_size" BETWEEN 1 AND 33554432),
  ADD CONSTRAINT "uploaded_documents_page_count_check" CHECK ("page_count" BETWEEN 1 AND 50),
  ADD CONSTRAINT "uploaded_documents_data_key_envelope_check" CHECK (
    "data_key_envelope" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("data_key_envelope") BETWEEN 41 AND 256),
  ADD CONSTRAINT "uploaded_documents_object_key_check" CHECK (
    "object_key" LIKE 'certification/%' AND char_length("object_key") <= 128),
  ADD CONSTRAINT "uploaded_documents_clean_sha256_check" CHECK (
    "clean_sha256" IS NULL OR octet_length("clean_sha256") = 32),
  ADD CONSTRAINT "uploaded_documents_clean_pair_check" CHECK (
    ("state" = 'clean') = ("clean_sha256" IS NOT NULL)),
  ADD CONSTRAINT "uploaded_documents_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."seller_draft_quotas"
  ADD CONSTRAINT "seller_draft_quotas_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_draft_quotas_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_draft_quotas_draft_bytes_check" CHECK ("draft_bytes" >= 0);

ALTER TABLE "certification"."rate_counters"
  ADD CONSTRAINT "rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'issuer-request.seller.day', 'reviewer-mail.market.hour', 'save.account.day',
    'save.account.minute', 'submit.certificate.day', 'upload.seller.day',
    'upload.unapproved-seller.day')),
  ADD CONSTRAINT "rate_counters_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "rate_counters_count_check" CHECK ("count" >= 0);

ALTER TABLE "certification"."seller_certification_draft_documents"
  ADD CONSTRAINT "seller_certification_draft_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_certification_draft_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_certification_draft_documents_position_check" CHECK ("position" >= 1);

ALTER TABLE "certification"."seller_submission_documents"
  ADD CONSTRAINT "seller_submission_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_submission_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_submission_documents_position_check" CHECK ("position" >= 1);

ALTER TABLE "certification"."seller_certification_history"
  ADD CONSTRAINT "seller_certification_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_certification_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_certification_history_from_status_check" CHECK (
    "from_status" IN ('draft', 'in-review', 'approved', 'changes-needed', 'declined', 'expired', 'revoked')),
  ADD CONSTRAINT "seller_certification_history_to_status_check" CHECK (
    "to_status" IN ('draft', 'in-review', 'approved', 'changes-needed', 'declined', 'expired', 'revoked')),
  ADD CONSTRAINT "seller_certification_history_actor_kind_check" CHECK (
    "actor_kind" IN ('seller', 'admin', 'system')),
  ADD CONSTRAINT "seller_certification_history_actor_pair_check" CHECK (
    ("actor_kind" = 'system') = ("actor_account_id" IS NULL)),
  ADD CONSTRAINT "seller_certification_history_reason_code_check" CHECK (
    "reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "seller_certification_history_note_ciphertext_check" CHECK (
    "note_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("note_ciphertext") BETWEEN 41 AND 8192);

-- Set-once guard of uploaded_documents (data design 3.9, 6.1): the identity of a file never
-- changes; only the state and the refusal code may move (a scanner arrives later). A trigger
-- function: no grant.
CREATE FUNCTION "certification"."uploaded_documents_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."market_id" <> OLD."market_id"
     OR NEW."owner_seller_id" IS DISTINCT FROM OLD."owner_seller_id"
     OR NEW."purpose" <> OLD."purpose"
     OR NEW."type_id" IS DISTINCT FROM OLD."type_id"
     OR NEW."byte_size" <> OLD."byte_size"
     OR NEW."data_key_envelope" <> OLD."data_key_envelope"
     OR NEW."object_key" <> OLD."object_key"
     OR (OLD."clean_sha256" IS NOT NULL AND NEW."clean_sha256" IS DISTINCT FROM OLD."clean_sha256")
     OR (OLD."media_type" IS NOT NULL AND NEW."media_type" IS DISTINCT FROM OLD."media_type")
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'certification.uploaded_documents: a set-once column cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "uploaded_documents_guard_update"
  BEFORE UPDATE ON "certification"."uploaded_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."uploaded_documents_guard"();

-- Only a clean file joins a draft or a submission (data design 3.8, AC 21). FOR SHARE keeps the
-- row from moving to another state while the link commits.
CREATE FUNCTION "certification"."document_link_clean"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "certification"."uploaded_documents"
    WHERE "market_id" = NEW."market_id" AND "id" = NEW."document_id" AND "state" = 'clean'
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'certification.%: only a clean document can be linked', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "seller_certification_draft_documents_clean" BEFORE INSERT
  ON "certification"."seller_certification_draft_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."document_link_clean"();
CREATE TRIGGER "seller_submission_documents_clean" BEFORE INSERT
  ON "certification"."seller_submission_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."document_link_clean"();

-- Append-only tables (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "seller_submission_documents_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."seller_submission_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_submission_documents_no_truncate"
  BEFORE TRUNCATE ON "certification"."seller_submission_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_certification_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."seller_certification_history"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_certification_history_no_truncate"
  BEFORE TRUNCATE ON "certification"."seller_certification_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. DELETE on the root is
-- for a never-submitted record (the submissions' restricting key refuses any other). An uploaded
-- document is inserted, read and deleted from the draft area; nothing updates it yet, so it gets
-- no UPDATE until a scanner exists.
GRANT DELETE ON TABLE "certification"."seller_certifications" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."uploaded_documents" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "certification"."seller_draft_quotas" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "certification"."rate_counters" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."seller_certification_draft_documents" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."seller_submission_documents" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."seller_certification_history" TO "mondapac_app";
