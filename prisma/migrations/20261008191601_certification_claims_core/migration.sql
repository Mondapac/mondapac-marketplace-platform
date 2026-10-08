-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "certification";

-- CreateTable
CREATE TABLE "certification"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "certification"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "certification"."certification_types" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "verification_mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "published_revision_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "certification_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."certification_type_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "verification_mode" TEXT NOT NULL,
    "requires_issuer_registry" BOOLEAN NOT NULL,
    "requires_document" BOOLEAN NOT NULL,
    "requires_expiry" BOOLEAN NOT NULL,
    "default_basis" TEXT NOT NULL,
    "auto_approve_self_declaration" BOOLEAN NOT NULL,
    "badge_icon_key" TEXT NOT NULL,
    "author_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "certification_type_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."issuers" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "display_name_key" TEXT NOT NULL,
    "accreditation_number" TEXT,
    "state" TEXT NOT NULL,
    "expert_reference_ciphertext" TEXT,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "state_changed_by_kind" TEXT NOT NULL,
    "state_changed_by_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issuers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."seller_certifications" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "pending_submission_id" UUID,
    "approved_submission_id" UUID,
    "approved_boundary_at" TIMESTAMPTZ(6),
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."seller_certification_submissions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_certification_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "type_revision_id" UUID NOT NULL,
    "submission_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "issuer_id" UUID,
    "certificate_number_ciphertext" TEXT,
    "issue_date" DATE,
    "expiry_date" DATE,
    "self_declared" BOOLEAN,
    "self_declaration_note_ciphertext" TEXT,
    "content_schema_version" SMALLINT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "submitted_zone" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,

    CONSTRAINT "seller_certification_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."seller_submission_decisions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "approved_zone" TEXT,
    "expiry_boundary_at" TIMESTAMPTZ(6),
    "reason_code" TEXT,
    "reason_text_ciphertext" TEXT,
    "withdraw_cause" TEXT,
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_submission_decisions_pkey" PRIMARY KEY ("market_id","submission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "certification"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "certification_types_market_id_id_key" ON "certification"."certification_types"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "certification_types_market_id_id_verification_mode_key" ON "certification"."certification_types"("market_id", "id", "verification_mode");

-- CreateIndex
CREATE UNIQUE INDEX "certification_types_market_id_code_key" ON "certification"."certification_types"("market_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "certification_type_revisions_market_id_id_key" ON "certification"."certification_type_revisions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "certification_type_revisions_market_id_type_id_id_key" ON "certification"."certification_type_revisions"("market_id", "type_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "certification_type_revisions_market_id_type_id_revision_no_key" ON "certification"."certification_type_revisions"("market_id", "type_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "issuers_market_id_id_key" ON "certification"."issuers"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "issuers_market_id_id_type_id_key" ON "certification"."issuers"("market_id", "id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuers_market_id_type_id_display_name_key_key" ON "certification"."issuers"("market_id", "type_id", "display_name_key");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certifications_market_id_id_key" ON "certification"."seller_certifications"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certifications_market_id_id_type_id_key" ON "certification"."seller_certifications"("market_id", "id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certifications_market_id_id_type_id_seller_id_key" ON "certification"."seller_certifications"("market_id", "id", "type_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_submissions_market_id_id_key" ON "certification"."seller_certification_submissions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_submissions_market_id_cert_id_id_key" ON "certification"."seller_certification_submissions"("market_id", "seller_certification_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_submissions_market_id_cert_id_no_key" ON "certification"."seller_certification_submissions"("market_id", "seller_certification_id", "submission_no");

-- CreateIndex
CREATE UNIQUE INDEX "seller_certification_submissions_market_id_id_issuer_id_key" ON "certification"."seller_certification_submissions"("market_id", "id", "issuer_id");

-- AddForeignKey
ALTER TABLE "certification"."certification_types" ADD CONSTRAINT "certification_types_market_id_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "certification"."certification_type_revisions"("market_id", "type_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."certification_type_revisions" ADD CONSTRAINT "certification_type_revisions_market_id_type_id_verificatio_fkey" FOREIGN KEY ("market_id", "type_id", "verification_mode") REFERENCES "certification"."certification_types"("market_id", "id", "verification_mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."issuers" ADD CONSTRAINT "issuers_market_id_type_id_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certifications" ADD CONSTRAINT "seller_certifications_market_id_type_id_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certifications" ADD CONSTRAINT "seller_certifications_market_id_id_pending_submission_id_fkey" FOREIGN KEY ("market_id", "id", "pending_submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "seller_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certifications" ADD CONSTRAINT "seller_certifications_market_id_id_approved_submission_id_fkey" FOREIGN KEY ("market_id", "id", "approved_submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "seller_certification_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_submissions" ADD CONSTRAINT "seller_certification_submissions_market_id_seller_certific_fkey" FOREIGN KEY ("market_id", "seller_certification_id", "type_id", "seller_id") REFERENCES "certification"."seller_certifications"("market_id", "id", "type_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_submissions" ADD CONSTRAINT "seller_certification_submissions_market_id_type_id_type_re_fkey" FOREIGN KEY ("market_id", "type_id", "type_revision_id") REFERENCES "certification"."certification_type_revisions"("market_id", "type_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_certification_submissions" ADD CONSTRAINT "seller_certification_submissions_market_id_issuer_id_type__fkey" FOREIGN KEY ("market_id", "issuer_id", "type_id") REFERENCES "certification"."issuers"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."seller_submission_decisions" ADD CONSTRAINT "seller_submission_decisions_market_id_submission_id_fkey" FOREIGN KEY ("market_id", "submission_id") REFERENCES "certification"."seller_certification_submissions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/certification.md sections 2 (C1, CE1 to CE6),
-- 3.1, 3.2, 3.4 to 3.7 and 3.19. Only new tables, so nothing here is NOT VALID.
-- Ciphertext columns: the v<N>. envelope and base64url, at least 41 characters (the v1 envelope
-- of an empty plaintext); the upper bounds follow sellers.md 4.5: 3 + ceil((4N + 28) * 4 / 3) characters for N plaintext
-- characters, rounded up to a power of two. Limits: certificate number 64 (512), notes and reasons
-- 1,000 (8192), expert reference 500 (4096); Mohammad confirms them in the value objects.
-- Clear free text (S7): no outer spaces, no C0/C1 control or bidi formatting character.
ALTER TABLE "certification"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^certification\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "certification"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^certification\.[a-z0-9-]+$');

ALTER TABLE "certification"."certification_types"
  ADD CONSTRAINT "certification_types_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "certification_types_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "certification_types_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "certification_types_verification_mode_check" CHECK (
    "verification_mode" IN ('THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION')),
  ADD CONSTRAINT "certification_types_status_check" CHECK ("status" IN ('active', 'inactive')),
  ADD CONSTRAINT "certification_types_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."certification_type_revisions"
  ADD CONSTRAINT "certification_type_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "certification_type_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "certification_type_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "certification_type_revisions_verification_mode_check" CHECK (
    "verification_mode" IN ('THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION')),
  ADD CONSTRAINT "certification_type_revisions_default_basis_check" CHECK (
    "default_basis" IN ('SELLER_REQUIRED', 'NOT_APPLICABLE')),
  ADD CONSTRAINT "certification_type_revisions_auto_approve_check" CHECK (
    NOT "auto_approve_self_declaration" OR "verification_mode" = 'SELF_DECLARATION'),
  ADD CONSTRAINT "certification_type_revisions_badge_icon_key_check" CHECK (
    "badge_icon_key" ~ '^[a-z][a-z0-9-]{0,63}$');

ALTER TABLE "certification"."issuers"
  ALTER COLUMN "display_name_key" TYPE TEXT COLLATE "C";
ALTER TABLE "certification"."issuers"
  ADD CONSTRAINT "issuers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "issuers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "issuers_display_name_check" CHECK (
    char_length("display_name") BETWEEN 1 AND 200
    AND "display_name" = btrim("display_name")
    AND "display_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "issuers_display_name_key_check" CHECK (
    char_length("display_name_key") BETWEEN 1 AND 400
    AND "display_name_key" = btrim("display_name_key")
    AND "display_name_key" IS NFKC NORMALIZED),
  ADD CONSTRAINT "issuers_accreditation_number_check" CHECK (
    "accreditation_number" IS NULL OR (
      char_length("accreditation_number") BETWEEN 1 AND 64
      AND "accreditation_number" = btrim("accreditation_number")
      AND "accreditation_number" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')),
  ADD CONSTRAINT "issuers_state_check" CHECK (
    "state" IN ('proposed', 'active', 'closed-to-new', 'derecognised')),
  ADD CONSTRAINT "issuers_expert_reference_check" CHECK (
    "state" = 'proposed' OR "expert_reference_ciphertext" IS NOT NULL),
  ADD CONSTRAINT "issuers_expert_reference_ciphertext_check" CHECK (
    "expert_reference_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("expert_reference_ciphertext") BETWEEN 41 AND 4096),
  ADD CONSTRAINT "issuers_state_changed_by_kind_check" CHECK (
    "state_changed_by_kind" IN ('admin', 'seed')),
  ADD CONSTRAINT "issuers_state_changed_by_pair_check" CHECK (
    ("state_changed_by_kind" = 'seed') = ("state_changed_by_account_id" IS NULL)),
  ADD CONSTRAINT "issuers_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."seller_certifications"
  ADD CONSTRAINT "seller_certifications_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_certifications_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_certifications_status_check" CHECK (
    "status" IN ('draft', 'in-review', 'approved', 'changes-needed', 'declined', 'expired', 'revoked')),
  ADD CONSTRAINT "seller_certifications_pointers_distinct_check" CHECK (
    "approved_submission_id" IS NULL OR "approved_submission_id" <> "pending_submission_id"),
  ADD CONSTRAINT "seller_certifications_approved_boundary_at_check" CHECK (
    "approved_boundary_at" IS NULL OR "approved_submission_id" IS NOT NULL),
  ADD CONSTRAINT "seller_certifications_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."seller_certification_submissions"
  ADD CONSTRAINT "seller_certification_submissions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_certification_submissions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_certification_submissions_submission_no_check" CHECK ("submission_no" >= 1),
  ADD CONSTRAINT "seller_certification_submissions_kind_check" CHECK (
    "kind" IN ('initial', 'resubmission', 'renewal')),
  ADD CONSTRAINT "seller_certification_submissions_dates_check" CHECK (
    "issue_date" IS NULL OR "expiry_date" IS NULL OR "issue_date" <= "expiry_date"),
  ADD CONSTRAINT "seller_certification_submissions_cert_number_ciphertext_check" CHECK (
    "certificate_number_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("certificate_number_ciphertext") BETWEEN 41 AND 512),
  ADD CONSTRAINT "seller_certification_submissions_note_ciphertext_check" CHECK (
    "self_declaration_note_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("self_declaration_note_ciphertext") BETWEEN 41 AND 8192),
  ADD CONSTRAINT "seller_certification_submissions_content_schema_version_check" CHECK (
    "content_schema_version" >= 1),
  ADD CONSTRAINT "seller_certification_submissions_content_hash_check" CHECK (
    "content_hash" ~ '^hmac-sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "seller_certification_submissions_submitted_zone_check" CHECK (
    "submitted_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("submitted_zone") <= 64);

ALTER TABLE "certification"."seller_submission_decisions"
  ADD CONSTRAINT "seller_submission_decisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_submission_decisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_submission_decisions_outcome_check" CHECK (
    "outcome" IN ('approved', 'changes-requested', 'declined', 'withdrawn')),
  ADD CONSTRAINT "seller_submission_decisions_approved_zone_check" CHECK (
    ("outcome" = 'approved') = ("approved_zone" IS NOT NULL)),
  ADD CONSTRAINT "seller_submission_decisions_approved_zone_shape_check" CHECK (
    "approved_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    AND char_length("approved_zone") <= 64),
  ADD CONSTRAINT "seller_submission_decisions_expiry_boundary_at_check" CHECK (
    "expiry_boundary_at" IS NULL OR "outcome" = 'approved'),
  ADD CONSTRAINT "seller_submission_decisions_reason_code_check" CHECK (
    ("reason_code" IS NOT NULL) = ("outcome" IN ('changes-requested', 'declined'))),
  ADD CONSTRAINT "seller_submission_decisions_reason_code_shape_check" CHECK (
    "reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "seller_submission_decisions_reason_text_ciphertext_check" CHECK (
    "reason_text_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("reason_text_ciphertext") BETWEEN 41 AND 8192),
  ADD CONSTRAINT "seller_submission_decisions_withdraw_cause_check" CHECK (
    "withdraw_cause" IN ('edited', 'cancelled', 'revoked')),
  ADD CONSTRAINT "seller_submission_decisions_withdraw_pair_check" CHECK (
    ("outcome" = 'withdrawn') = ("withdraw_cause" IS NOT NULL)),
  ADD CONSTRAINT "seller_submission_decisions_actor_kind_check" CHECK (
    "actor_kind" IN ('seller', 'admin', 'system')),
  ADD CONSTRAINT "seller_submission_decisions_actor_pair_check" CHECK (
    ("actor_kind" = 'system') = ("actor_account_id" IS NULL));

-- Hand-written partial indexes (invisible to Prisma; listed in the catalog test).
-- T1 option A: at most one non-terminal certificate per seller and type (D 2.3); it is also the
-- index of statement S1, which repeats the predicate with literals.
CREATE UNIQUE INDEX "seller_certifications_market_id_seller_id_type_id_open_key"
  ON "certification"."seller_certifications" ("market_id", "seller_id", "type_id")
  WHERE "status" NOT IN ('declined', 'revoked');
-- A9: the expiry job reads only live approved records.
CREATE INDEX "seller_certifications_market_id_approved_boundary_at_idx"
  ON "certification"."seller_certifications" ("market_id", "approved_boundary_at")
  WHERE "status" = 'approved';
-- The relay's claim (platform persistence design 6.1).
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "certification"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
-- The issuer uniqueness rule for the public accreditation reference (data design 3.7).
CREATE UNIQUE INDEX "issuers_market_id_type_id_accreditation_number_key"
  ON "certification"."issuers" ("market_id", "type_id", "accreditation_number")
  WHERE "accreditation_number" IS NOT NULL;

-- Append-only tables (CE3, data design 6.1): one trigger function, a row trigger for UPDATE and
-- DELETE and a statement trigger for TRUNCATE, which refuse for every role, the owner included.
-- The function is a trigger function: it gets no grant (platform.md 10.2).
CREATE FUNCTION "certification"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'certification.%: append-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "certification_type_revisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."certification_type_revisions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "certification_type_revisions_no_truncate"
  BEFORE TRUNCATE ON "certification"."certification_type_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_certification_submissions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."seller_certification_submissions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_certification_submissions_no_truncate"
  BEFORE TRUNCATE ON "certification"."seller_certification_submissions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_submission_decisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."seller_submission_decisions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "seller_submission_decisions_no_truncate"
  BEFORE TRUNCATE ON "certification"."seller_submission_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. DELETE arrives with
-- the slice that first deletes from a table (never for these).
GRANT USAGE ON SCHEMA "certification" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "certification"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "published_revision_id", "version") ON TABLE "certification"."certification_types" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."certification_type_revisions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("display_name", "display_name_key", "accreditation_number", "state", "expert_reference_ciphertext", "state_changed_at", "state_changed_by_kind", "state_changed_by_account_id", "version") ON TABLE "certification"."issuers" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "certification"."seller_certifications" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."seller_certification_submissions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."seller_submission_decisions" TO "mondapac_app";
