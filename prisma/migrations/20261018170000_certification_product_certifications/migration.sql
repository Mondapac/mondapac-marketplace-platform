-- Certification slice 14, the manufacturer certificate (data design 3.15, 3.16; D 2.1, 3.4;
-- ADR-0012 d3, ADR-0028 d7; AC 20): the root with its draft and the draft's coverage and editors,
-- the insert-only revisions with their coverage, editors and decision, the issuer confirmation of
-- a revision and the status history. Coverage records the published product revision it was
-- checked against (M3) and is the lookup of statement S3 (A3). Not in this migration (the
-- documents part of the slice): `product_certification_draft_documents`,
-- `product_revision_documents` and `product_revision_review_checks`. One addition to 3.16 (I1):
-- `product_certification_revisions.type_revision_id`, the type revision in force at submission,
-- bound to the type like a seller submission's.

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "certification"."product_certifications" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "pending_revision_id" UUID,
    "approved_revision_id" UUID,
    "approved_boundary_at" TIMESTAMPTZ(6),
    "draft_manufacturer_name" TEXT,
    "draft_issuer_id" UUID,
    "draft_certificate_number_ciphertext" TEXT,
    "draft_issue_date" DATE,
    "draft_expiry_date" DATE,
    "author_account_id" UUID NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."product_certification_draft_coverage" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_revision_id" UUID NOT NULL,
    "variant_id" UUID,

    CONSTRAINT "product_certification_draft_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."product_certification_draft_editors" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "first_edited_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_certification_draft_editors_pkey" PRIMARY KEY ("market_id","product_certification_id","account_id")
);

-- CreateTable
CREATE TABLE "certification"."product_certification_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "type_revision_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "issuer_id" UUID NOT NULL,
    "manufacturer_name" TEXT NOT NULL,
    "certificate_number_ciphertext" TEXT NOT NULL,
    "issue_date" DATE,
    "expiry_date" DATE,
    "author_account_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_certification_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."product_revision_coverage" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_revision_id" UUID NOT NULL,
    "variant_id" UUID,

    CONSTRAINT "product_revision_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."product_revision_editors" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "product_revision_editors_pkey" PRIMARY KEY ("market_id","revision_id","account_id")
);

-- CreateTable
CREATE TABLE "certification"."product_revision_decisions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "expiry_boundary_at" TIMESTAMPTZ(6),
    "boundary_zone" TEXT,
    "reason_code" TEXT,
    "author_account_id" UUID NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_revision_decisions_pkey" PRIMARY KEY ("market_id","revision_id")
);

-- CreateTable
CREATE TABLE "certification"."product_issuer_confirmations" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "issuer_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "confirmed_on" DATE NOT NULL,
    "reference_ciphertext" TEXT NOT NULL,
    "confirms_number" BOOLEAN NOT NULL,
    "confirms_holder" BOOLEAN NOT NULL,
    "recorded_by_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_issuer_confirmations_pkey" PRIMARY KEY ("market_id","revision_id")
);

-- CreateTable
CREATE TABLE "certification"."product_certification_history" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "revision_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "reason_code" TEXT,
    "note_ciphertext" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_certification_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_certifications_market_id_created_at_id_idx" ON "certification"."product_certifications"("market_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certifications_market_id_id_key" ON "certification"."product_certifications"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certifications_market_id_id_type_id_key" ON "certification"."product_certifications"("market_id", "id", "type_id");

-- CreateIndex
CREATE INDEX "product_certification_draft_coverage_market_id_product_cert_idx" ON "certification"."product_certification_draft_coverage"("market_id", "product_certification_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_draft_coverage_market_id_id_key" ON "certification"."product_certification_draft_coverage"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_id_key" ON "certification"."product_certification_revisions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_cert_id_id_key" ON "certification"."product_certification_revisions"("market_id", "product_certification_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_cert_id_no_key" ON "certification"."product_certification_revisions"("market_id", "product_certification_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_id_type_id_key" ON "certification"."product_certification_revisions"("market_id", "id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_id_issuer_id_key" ON "certification"."product_certification_revisions"("market_id", "id", "issuer_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_revisions_market_id_id_author_account_key" ON "certification"."product_certification_revisions"("market_id", "id", "author_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_coverage_market_id_id_key" ON "certification"."product_revision_coverage"("market_id", "id");

-- CreateIndex
-- A3 (data design 3.16, 12): statement S3 is an index-only scan on it. The design's INCLUDE
-- columns are trailing key columns, so the index is in the Prisma schema (no drift).
CREATE INDEX "product_revision_coverage_lookup_idx" ON "certification"."product_revision_coverage"("market_id", "product_id", "type_id", "product_revision_id", "variant_id", "revision_id");

-- Mojtaba F1: the coverage of one revision (the revision read) and the referencing side of the
-- composite foreign key to the revision.
CREATE INDEX "product_revision_coverage_market_id_revision_id_type_id_idx" ON "certification"."product_revision_coverage"("market_id", "revision_id", "type_id");

-- CreateIndex
CREATE INDEX "product_certification_history_market_id_product_certificati_idx" ON "certification"."product_certification_history"("market_id", "product_certification_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_certification_history_market_id_id_key" ON "certification"."product_certification_history"("market_id", "id");

-- AddForeignKey
ALTER TABLE "certification"."product_certifications" ADD CONSTRAINT "product_certifications_type_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certifications" ADD CONSTRAINT "product_certifications_draft_issuer_fkey" FOREIGN KEY ("market_id", "draft_issuer_id", "type_id") REFERENCES "certification"."issuers"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certifications" ADD CONSTRAINT "product_certifications_pending_revision_fkey" FOREIGN KEY ("market_id", "id", "pending_revision_id") REFERENCES "certification"."product_certification_revisions"("market_id", "product_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certifications" ADD CONSTRAINT "product_certifications_approved_revision_fkey" FOREIGN KEY ("market_id", "id", "approved_revision_id") REFERENCES "certification"."product_certification_revisions"("market_id", "product_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_draft_coverage" ADD CONSTRAINT "product_certification_draft_coverage_certificate_fkey" FOREIGN KEY ("market_id", "product_certification_id") REFERENCES "certification"."product_certifications"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_draft_editors" ADD CONSTRAINT "product_certification_draft_editors_certificate_fkey" FOREIGN KEY ("market_id", "product_certification_id") REFERENCES "certification"."product_certifications"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_revisions" ADD CONSTRAINT "product_certification_revisions_certificate_fkey" FOREIGN KEY ("market_id", "product_certification_id", "type_id") REFERENCES "certification"."product_certifications"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_revisions" ADD CONSTRAINT "product_certification_revisions_type_revision_fkey" FOREIGN KEY ("market_id", "type_id", "type_revision_id") REFERENCES "certification"."certification_type_revisions"("market_id", "type_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_revisions" ADD CONSTRAINT "product_certification_revisions_issuer_fkey" FOREIGN KEY ("market_id", "issuer_id", "type_id") REFERENCES "certification"."issuers"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_coverage" ADD CONSTRAINT "product_revision_coverage_revision_fkey" FOREIGN KEY ("market_id", "revision_id", "type_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_editors" ADD CONSTRAINT "product_revision_editors_revision_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_revision_decisions" ADD CONSTRAINT "product_revision_decisions_revision_fkey" FOREIGN KEY ("market_id", "revision_id", "author_account_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id", "author_account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_issuer_confirmations" ADD CONSTRAINT "product_issuer_confirmations_revision_fkey" FOREIGN KEY ("market_id", "revision_id", "issuer_id") REFERENCES "certification"."product_certification_revisions"("market_id", "id", "issuer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_issuer_confirmations" ADD CONSTRAINT "product_issuer_confirmations_channel_fkey" FOREIGN KEY ("market_id", "issuer_id", "channel_id") REFERENCES "certification"."issuer_contact_channels"("market_id", "issuer_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_history" ADD CONSTRAINT "product_certification_history_certificate_fkey" FOREIGN KEY ("market_id", "product_certification_id") REFERENCES "certification"."product_certifications"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."product_certification_history" ADD CONSTRAINT "product_certification_history_revision_fkey" FOREIGN KEY ("market_id", "product_certification_id", "revision_id") REFERENCES "certification"."product_certification_revisions"("market_id", "product_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (data design 9.4): the partial indexes invisible to Prisma, listed in the catalog
-- test. A9: the expiry job reads only live approved records. The approved pointer names one revision.
CREATE INDEX "product_certifications_market_id_approved_boundary_at_idx"
  ON "certification"."product_certifications" ("market_id", "approved_boundary_at")
  WHERE "status" = 'approved';
CREATE UNIQUE INDEX "product_certifications_market_id_approved_revision_id_key"
  ON "certification"."product_certifications" ("market_id", "approved_revision_id")
  WHERE "approved_revision_id" IS NOT NULL;
-- A whole-product entry and a variant-narrowed entry are distinct rows (ruling L1); whether both
-- may coexist for one product is the aggregate's (Q-C7).
CREATE UNIQUE INDEX "product_certification_draft_coverage_whole_key"
  ON "certification"."product_certification_draft_coverage" ("market_id", "product_certification_id", "product_id")
  WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "product_certification_draft_coverage_variant_key"
  ON "certification"."product_certification_draft_coverage" ("market_id", "product_certification_id", "product_id", "variant_id")
  WHERE "variant_id" IS NOT NULL;
CREATE UNIQUE INDEX "product_revision_coverage_whole_key"
  ON "certification"."product_revision_coverage" ("market_id", "revision_id", "product_id")
  WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "product_revision_coverage_variant_key"
  ON "certification"."product_revision_coverage" ("market_id", "revision_id", "product_id", "variant_id")
  WHERE "variant_id" IS NOT NULL;

-- Hand-written CHECKs (data design 3.15, 3.16; S4, S7, S8, CE6).
ALTER TABLE "certification"."product_certifications"
  ADD CONSTRAINT "product_certifications_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certifications_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_certifications_status_check" CHECK (
    "status" IN ('draft', 'in-review', 'approved', 'rejected', 'suspended', 'revoked', 'expired')),
  ADD CONSTRAINT "product_certifications_pointers_distinct_check" CHECK (
    "approved_revision_id" IS NULL OR "approved_revision_id" <> "pending_revision_id"),
  ADD CONSTRAINT "product_certifications_approved_boundary_at_check" CHECK (
    "approved_boundary_at" IS NULL OR "approved_revision_id" IS NOT NULL),
  ADD CONSTRAINT "product_certifications_draft_manufacturer_name_check" CHECK (
    char_length("draft_manufacturer_name") BETWEEN 1 AND 200
    AND "draft_manufacturer_name" = btrim("draft_manufacturer_name")
    AND "draft_manufacturer_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "product_certifications_draft_cert_number_ciphertext_check" CHECK (
    "draft_certificate_number_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("draft_certificate_number_ciphertext") BETWEEN 41 AND 512),
  ADD CONSTRAINT "product_certifications_draft_dates_check" CHECK (
    "draft_issue_date" IS NULL OR "draft_expiry_date" IS NULL OR "draft_issue_date" <= "draft_expiry_date"),
  ADD CONSTRAINT "product_certifications_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."product_certification_draft_coverage"
  ADD CONSTRAINT "product_certification_draft_coverage_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certification_draft_coverage_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "certification"."product_certification_draft_editors"
  ADD CONSTRAINT "product_certification_draft_editors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certification_draft_editors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "certification"."product_certification_revisions"
  ADD CONSTRAINT "product_certification_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certification_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_certification_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "product_certification_revisions_manufacturer_name_check" CHECK (
    char_length("manufacturer_name") BETWEEN 1 AND 200
    AND "manufacturer_name" = btrim("manufacturer_name")
    AND "manufacturer_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "product_certification_revisions_cert_number_ciphertext_check" CHECK (
    "certificate_number_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("certificate_number_ciphertext") BETWEEN 41 AND 512),
  ADD CONSTRAINT "product_certification_revisions_dates_check" CHECK (
    "issue_date" IS NULL OR "expiry_date" IS NULL OR "issue_date" <= "expiry_date"),
  -- One kind until the design picks (Mojtaba, 2026-10-08): the HMAC under the platform subject.
  ADD CONSTRAINT "product_certification_revisions_content_hash_check" CHECK (
    "content_hash" ~ '^(sha256|hmac-sha256):[0-9a-f]{64}$');

ALTER TABLE "certification"."product_revision_coverage"
  ADD CONSTRAINT "product_revision_coverage_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_coverage_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "certification"."product_revision_editors"
  ADD CONSTRAINT "product_revision_editors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_editors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "certification"."product_revision_decisions"
  ADD CONSTRAINT "product_revision_decisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_decisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_decisions_outcome_check" CHECK (
    "outcome" IN ('approved', 'rejected', 'withdrawn')),
  -- The database half of "another person" (AC 20; measured, data design 12); the editor set is
  -- the aggregate's (6).
  ADD CONSTRAINT "product_revision_decisions_not_author_check" CHECK (
    "decided_by_account_id" IS NULL OR "decided_by_account_id" <> "author_account_id"),
  -- Hassan M-a: an approval or a rejection always names a person.
  ADD CONSTRAINT "product_revision_decisions_decided_by_check" CHECK (
    ("decided_by_account_id" IS NULL) = ("outcome" = 'withdrawn')),
  ADD CONSTRAINT "product_revision_decisions_boundary_pair_check" CHECK (
    ("expiry_boundary_at" IS NULL) = ("boundary_zone" IS NULL)),
  ADD CONSTRAINT "product_revision_decisions_boundary_check" CHECK (
    "expiry_boundary_at" IS NULL OR "outcome" = 'approved'),
  ADD CONSTRAINT "product_revision_decisions_boundary_zone_check" CHECK (
    "boundary_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("boundary_zone") <= 64),
  ADD CONSTRAINT "product_revision_decisions_reason_code_check" CHECK (
    ("reason_code" IS NOT NULL) = ("outcome" = 'rejected')),
  ADD CONSTRAINT "product_revision_decisions_reason_code_shape_check" CHECK (
    "reason_code" ~ '^[a-z][a-z0-9-]{0,63}$');

ALTER TABLE "certification"."product_issuer_confirmations"
  ADD CONSTRAINT "product_issuer_confirmations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_issuer_confirmations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_issuer_confirmations_reference_ciphertext_check" CHECK (
    "reference_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("reference_ciphertext") BETWEEN 41 AND 4096),
  -- A row exists only for a full confirmation, so `verifiedWithIssuer` is "a row exists".
  ADD CONSTRAINT "product_issuer_confirmations_both_ticks_check" CHECK (
    "confirms_number" AND "confirms_holder");

ALTER TABLE "certification"."product_certification_history"
  ADD CONSTRAINT "product_certification_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_certification_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_certification_history_from_status_check" CHECK (
    "from_status" IN ('draft', 'in-review', 'approved', 'rejected', 'suspended', 'revoked', 'expired')),
  ADD CONSTRAINT "product_certification_history_to_status_check" CHECK (
    "to_status" IN ('draft', 'in-review', 'approved', 'rejected', 'suspended', 'revoked', 'expired')),
  ADD CONSTRAINT "product_certification_history_actor_kind_check" CHECK (
    "actor_kind" IN ('admin', 'system')),
  ADD CONSTRAINT "product_certification_history_actor_pair_check" CHECK (
    ("actor_kind" = 'system') = ("actor_account_id" IS NULL)),
  ADD CONSTRAINT "product_certification_history_reason_code_check" CHECK (
    "reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "product_certification_history_note_ciphertext_check" CHECK (
    "note_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("note_ciphertext") BETWEEN 41 AND 8192);

-- Insert-only (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "product_certification_revisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_certification_revisions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_certification_revisions_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_certification_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_coverage_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_revision_coverage"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_coverage_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_revision_coverage"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_editors_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_revision_editors"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_editors_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_revision_editors"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_decisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_revision_decisions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_revision_decisions_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_revision_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_issuer_confirmations_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_issuer_confirmations"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_issuer_confirmations_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_issuer_confirmations"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_certification_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."product_certification_history"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "product_certification_history_no_truncate"
  BEFORE TRUNCATE ON "certification"."product_certification_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8.
GRANT SELECT, INSERT, UPDATE ON TABLE "certification"."product_certifications" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_coverage" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_editors" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_certification_revisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_revision_coverage" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_revision_editors" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_revision_decisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_issuer_confirmations" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."product_certification_history" TO "mondapac_app";
