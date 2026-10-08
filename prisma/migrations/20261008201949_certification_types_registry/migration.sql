-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "certification"."certification_type_revisions" ADD COLUMN     "change_reason_ciphertext" TEXT;

-- CreateTable
CREATE TABLE "certification"."type_revision_texts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_revision_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customer_description" TEXT NOT NULL,

    CONSTRAINT "type_revision_texts_pkey" PRIMARY KEY ("market_id","type_revision_id","locale")
);

-- CreateTable
CREATE TABLE "certification"."claim_terms" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_revision_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,

    CONSTRAINT "claim_terms_pkey" PRIMARY KEY ("market_id","type_revision_id","locale","phrase")
);

-- CreateTable
CREATE TABLE "certification"."issuer_contact_channels" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issuer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issuer_contact_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."relaxation_proposals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "based_on_revision_id" UUID,
    "proposed_revision_id" UUID,
    "proposed_expert_reference_ciphertext" TEXT,
    "state" TEXT NOT NULL,
    "proposer_account_id" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "change_reason_ciphertext" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "relaxation_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."platform_subjects" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_subjects_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issuer_contact_channels_market_id_id_key" ON "certification"."issuer_contact_channels"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_contact_channels_market_id_issuer_id_id_key" ON "certification"."issuer_contact_channels"("market_id", "issuer_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "relaxation_proposals_market_id_id_key" ON "certification"."relaxation_proposals"("market_id", "id");

-- AddForeignKey
ALTER TABLE "certification"."type_revision_texts" ADD CONSTRAINT "type_revision_texts_market_id_type_revision_id_fkey" FOREIGN KEY ("market_id", "type_revision_id") REFERENCES "certification"."certification_type_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."claim_terms" ADD CONSTRAINT "claim_terms_market_id_type_revision_id_locale_fkey" FOREIGN KEY ("market_id", "type_revision_id", "locale") REFERENCES "certification"."type_revision_texts"("market_id", "type_revision_id", "locale") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."issuer_contact_channels" ADD CONSTRAINT "issuer_contact_channels_market_id_issuer_id_fkey" FOREIGN KEY ("market_id", "issuer_id") REFERENCES "certification"."issuers"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/certification.md sections 2, 3.2, 3.3, 3.7,
-- 3.20, 3.22, 6.1 and 8. Only new tables and one new nullable column, so nothing is NOT VALID (the CHECK on the new
-- column of certification_type_revisions is plain: all NULL, no deployed environment; 9.1).
-- Clear free text (S7): no outer spaces, no C0/C1 control or bidi formatting character.
-- Ciphertext bounds: data design 4.4 (the change reason and the expert reference are 500 characters).
ALTER TABLE "certification"."certification_type_revisions"
  ADD CONSTRAINT "certification_type_revisions_change_reason_ciphertext_check" CHECK (
    "change_reason_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("change_reason_ciphertext") BETWEEN 41 AND 4096);

ALTER TABLE "certification"."type_revision_texts"
  ADD CONSTRAINT "type_revision_texts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "type_revision_texts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "type_revision_texts_locale_check" CHECK (
    "locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
  ADD CONSTRAINT "type_revision_texts_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 100
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "type_revision_texts_customer_description_check" CHECK (
    char_length("customer_description") BETWEEN 1 AND 2000
    AND "customer_description" = btrim("customer_description")
    AND "customer_description" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]');

ALTER TABLE "certification"."claim_terms"
  ADD CONSTRAINT "claim_terms_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "claim_terms_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "claim_terms_phrase_check" CHECK (
    char_length("phrase") BETWEEN 1 AND 100
    AND "phrase" = btrim("phrase")
    AND "phrase" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]');

ALTER TABLE "certification"."issuer_contact_channels"
  ADD CONSTRAINT "issuer_contact_channels_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "issuer_contact_channels_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "issuer_contact_channels_kind_check" CHECK (
    "kind" IN ('email-domain', 'phone', 'web-page')),
  ADD CONSTRAINT "issuer_contact_channels_value_check" CHECK (
    char_length("value") BETWEEN 1 AND 255
    AND "value" = btrim("value")
    AND "value" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "issuer_contact_channels_retired_at_check" CHECK (
    "retired_at" IS NULL OR "retired_at" >= "created_at");

ALTER TABLE "certification"."relaxation_proposals"
  ADD CONSTRAINT "relaxation_proposals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "relaxation_proposals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "relaxation_proposals_subject_kind_check" CHECK (
    "subject_kind" IN ('type-revision', 'claim-policy-revision', 'issuer-reactivation', 'type-reactivation')),
  ADD CONSTRAINT "relaxation_proposals_proposed_revision_check" CHECK (
    ("subject_kind" IN ('type-revision', 'claim-policy-revision')) = ("proposed_revision_id" IS NOT NULL)),
  ADD CONSTRAINT "relaxation_proposals_expert_reference_check" CHECK (
    ("subject_kind" = 'issuer-reactivation') = ("proposed_expert_reference_ciphertext" IS NOT NULL)),
  ADD CONSTRAINT "relaxation_proposals_expert_reference_ciphertext_check" CHECK (
    "proposed_expert_reference_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("proposed_expert_reference_ciphertext") BETWEEN 41 AND 4096),
  ADD CONSTRAINT "relaxation_proposals_state_check" CHECK (
    "state" IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  ADD CONSTRAINT "relaxation_proposals_second_admin_check" CHECK (
    "decided_by_account_id" IS NULL OR "decided_by_account_id" <> "proposer_account_id"),
  ADD CONSTRAINT "relaxation_proposals_decided_by_check" CHECK (
    ("state" IN ('approved', 'rejected')) = ("decided_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "relaxation_proposals_decided_at_check" CHECK (
    ("state" = 'pending') = ("decided_at" IS NULL)),
  ADD CONSTRAINT "relaxation_proposals_change_reason_ciphertext_check" CHECK (
    "change_reason_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("change_reason_ciphertext") BETWEEN 41 AND 4096),
  ADD CONSTRAINT "relaxation_proposals_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."platform_subjects"
  ADD CONSTRAINT "platform_subjects_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_subjects_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- One pending proposal per subject (D 7.6); a second save is refused by the insert's unique
-- violation, never read-then-insert. Invisible to Prisma; listed in the catalog test.
CREATE UNIQUE INDEX "relaxation_proposals_market_id_subject_pending_key"
  ON "certification"."relaxation_proposals" ("market_id", "subject_kind", "subject_id")
  WHERE "state" = 'pending';

-- Append-only tables (CE3, data design 6.1): the trigger function of migration 1.
CREATE TRIGGER "type_revision_texts_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."type_revision_texts"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "type_revision_texts_no_truncate"
  BEFORE TRUNCATE ON "certification"."type_revision_texts"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "claim_terms_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."claim_terms"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "claim_terms_no_truncate"
  BEFORE TRUNCATE ON "certification"."claim_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Hand-written guards (Hassan M1, M2, L1; database-designer). A proposal is decided once and a
-- decided row is frozen for every role, the owner included; the version moves by one. A
-- channel is retired once, never revived or back-dated. Texts and claim terms join a revision
-- in the transaction that inserted the revision and before it is pointed at: the published pointer
-- of a type or the proposed revision of a proposal (3.20: a save is a new revision).
CREATE FUNCTION "certification"."relaxation_proposals_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'certification.relaxation_proposals: a decided proposal is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" = 'pending' OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'certification.relaxation_proposals: a pending proposal moves to a final state, version + 1'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "relaxation_proposals_one_way"
  BEFORE UPDATE ON "certification"."relaxation_proposals"
  FOR EACH ROW EXECUTE FUNCTION "certification"."relaxation_proposals_guard_update"();

CREATE FUNCTION "certification"."issuer_contact_channels_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."retired_at" IS NOT NULL OR NEW."retired_at" IS NULL THEN
    RAISE EXCEPTION 'certification.issuer_contact_channels: a channel is retired once, never revived'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "issuer_contact_channels_retire_once"
  BEFORE UPDATE ON "certification"."issuer_contact_channels"
  FOR EACH ROW EXECUTE FUNCTION "certification"."issuer_contact_channels_guard_update"();

CREATE FUNCTION "certification"."revision_content_guard_insert"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- The revision row must be the one this transaction inserted (a save is a new revision, 3.20):
  -- a row of an earlier transaction, published once and replaced or never, takes no content.
  -- A missing revision falls through to the foreign key.
  IF EXISTS (
       SELECT 1 FROM "certification"."certification_type_revisions" r
        WHERE r."market_id" = NEW."market_id" AND r."id" = NEW."type_revision_id"
          AND r.xmin <> pg_current_xact_id()::xid)
     OR EXISTS (
       SELECT 1 FROM "certification"."certification_types" t
        WHERE t."market_id" = NEW."market_id" AND t."published_revision_id" = NEW."type_revision_id")
     OR EXISTS (
       SELECT 1 FROM "certification"."relaxation_proposals" p
        WHERE p."market_id" = NEW."market_id" AND p."proposed_revision_id" = NEW."type_revision_id") THEN
    RAISE EXCEPTION 'certification.%: the revision is published or proposed, a change is a new revision', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "type_revision_texts_revision_open"
  BEFORE INSERT ON "certification"."type_revision_texts"
  FOR EACH ROW EXECUTE FUNCTION "certification"."revision_content_guard_insert"();
CREATE TRIGGER "claim_terms_revision_open"
  BEFORE INSERT ON "certification"."claim_terms"
  FOR EACH ROW EXECUTE FUNCTION "certification"."revision_content_guard_insert"();

-- Grants (database-designer): docs/design/data/certification.md section 8. The new column of
-- certification_type_revisions is covered by its existing table-level INSERT and SELECT.
GRANT SELECT, INSERT ON TABLE "certification"."type_revision_texts" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."claim_terms" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("retired_at") ON TABLE "certification"."issuer_contact_channels" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "decided_by_account_id", "decided_at", "version") ON TABLE "certification"."relaxation_proposals" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."platform_subjects" TO "mondapac_app";
