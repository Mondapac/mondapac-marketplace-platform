-- Certification slice 13, the claim basis policy (data design 3.14; D 2.1, 3.7; ADR-0012 d2;
-- CERT-42): one policy per Market and type, its insert-only revisions and rows, and the flags of
-- the retired-category backstop (D 3.7, B2). `SELLER_OR_MANUFACTURER` only on a platform-category
-- row (M1); at most one row per selector in a revision. A category id is `catalog`'s (C4: no FK).

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "certification"."claim_basis_policies" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type_id" UUID NOT NULL,
    "published_revision_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_basis_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."claim_policy_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "change_reason_ciphertext" TEXT,
    "author_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_policy_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."claim_policy_rows" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "selector_kind" TEXT NOT NULL,
    "category_id" UUID,
    "handling" TEXT,
    "basis" TEXT NOT NULL,

    CONSTRAINT "claim_policy_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."retired_category_flags" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL,
    "cleared_at" TIMESTAMPTZ(6),
    "cleared_by_account_id" UUID,

    CONSTRAINT "retired_category_flags_pkey" PRIMARY KEY ("market_id","category_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_basis_policies_market_id_id_key" ON "certification"."claim_basis_policies"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_basis_policies_market_id_type_id_key" ON "certification"."claim_basis_policies"("market_id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_revisions_market_id_id_key" ON "certification"."claim_policy_revisions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_revisions_market_id_policy_id_id_key" ON "certification"."claim_policy_revisions"("market_id", "policy_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_revisions_market_id_policy_id_revision_no_key" ON "certification"."claim_policy_revisions"("market_id", "policy_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_rows_market_id_revision_id_category_id_key" ON "certification"."claim_policy_rows"("market_id", "revision_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_policy_rows_market_id_revision_id_handling_key" ON "certification"."claim_policy_rows"("market_id", "revision_id", "handling");

-- AddForeignKey
ALTER TABLE "certification"."claim_basis_policies" ADD CONSTRAINT "claim_basis_policies_type_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."claim_basis_policies" ADD CONSTRAINT "claim_basis_policies_published_revision_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "certification"."claim_policy_revisions"("market_id", "policy_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."claim_policy_revisions" ADD CONSTRAINT "claim_policy_revisions_policy_fkey" FOREIGN KEY ("market_id", "policy_id") REFERENCES "certification"."claim_basis_policies"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."claim_policy_rows" ADD CONSTRAINT "claim_policy_rows_revision_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "certification"."claim_policy_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (data design 9.4): the partial index of A12 (`assertCategoriesRetirable`, B2).
CREATE INDEX "claim_policy_rows_market_id_category_id_idx"
  ON "certification"."claim_policy_rows"("market_id", "category_id")
  WHERE "category_id" IS NOT NULL;

-- Hand-written CHECKs (data design 3.14; S4, S8).
ALTER TABLE "certification"."claim_basis_policies"
  ADD CONSTRAINT "claim_basis_policies_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "claim_basis_policies_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "claim_basis_policies_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."claim_policy_revisions"
  ADD CONSTRAINT "claim_policy_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "claim_policy_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "claim_policy_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "claim_policy_revisions_change_reason_ciphertext_check" CHECK (
    "change_reason_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("change_reason_ciphertext") BETWEEN 41 AND 4096);

ALTER TABLE "certification"."claim_policy_rows"
  ADD CONSTRAINT "claim_policy_rows_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "claim_policy_rows_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "claim_policy_rows_selector_kind_check" CHECK (
    "selector_kind" IN ('platform-category', 'handling')),
  ADD CONSTRAINT "claim_policy_rows_handling_check" CHECK (
    "handling" IN ('SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH')),
  ADD CONSTRAINT "claim_policy_rows_basis_check" CHECK (
    "basis" IN ('SELLER_REQUIRED', 'SELLER_OR_MANUFACTURER', 'NOT_APPLICABLE')),
  ADD CONSTRAINT "claim_policy_rows_selector_check" CHECK (
    ("selector_kind" = 'platform-category') = ("category_id" IS NOT NULL)
    AND ("selector_kind" = 'handling') = ("handling" IS NOT NULL)),
  -- Ruling M1 (D 16.1 item 8): handling can only tighten.
  ADD CONSTRAINT "claim_policy_rows_manufacturer_basis_check" CHECK (
    "basis" <> 'SELLER_OR_MANUFACTURER' OR "selector_kind" = 'platform-category');

ALTER TABLE "certification"."retired_category_flags"
  ADD CONSTRAINT "retired_category_flags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "retired_category_flags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "retired_category_flags_cleared_check" CHECK (
    ("cleared_at" IS NULL) = ("cleared_by_account_id" IS NULL));

-- Insert-only (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "claim_policy_revisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."claim_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "claim_policy_revisions_no_truncate"
  BEFORE TRUNCATE ON "certification"."claim_policy_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "claim_policy_rows_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."claim_policy_rows"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "claim_policy_rows_no_truncate"
  BEFORE TRUNCATE ON "certification"."claim_policy_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8.
GRANT SELECT, INSERT, UPDATE ("published_revision_id", "version") ON TABLE "certification"."claim_basis_policies" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."claim_policy_revisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."claim_policy_rows" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("cleared_at", "cleared_by_account_id") ON TABLE "certification"."retired_category_flags" TO "mondapac_app";
