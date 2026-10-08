-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "catalog"."products" ADD COLUMN     "pending_revision_id" UUID,
ADD COLUMN     "pending_submitted_at" TIMESTAMPTZ(6),
ADD COLUMN     "published_revision_id" UUID;

-- CreateTable
CREATE TABLE "catalog"."product_working_copies" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "content_schema_version" SMALLINT NOT NULL,
    "base_revision_id" UUID,
    "last_saved_at" TIMESTAMPTZ(6) NOT NULL,
    "last_saved_by_account_id" UUID NOT NULL,

    CONSTRAINT "product_working_copies_pkey" PRIMARY KEY ("market_id","product_id")
);

-- CreateTable
CREATE TABLE "catalog"."product_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "revision_kind" TEXT NOT NULL,
    "base_revision_id" UUID,
    "reverted_from_revision_id" UUID,
    "family_revision_id" UUID NOT NULL,
    "definition_revision_ids" UUID[],
    "tax_category_code" TEXT NOT NULL,
    "attribute_values" JSONB NOT NULL,
    "field_provenance" JSONB,
    "sensitive" BOOLEAN NOT NULL,
    "sensitive_reasons" TEXT[],
    "content_schema_version" SMALLINT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_account_id" UUID NOT NULL,
    "acting_admin_account_id" UUID,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."product_revision_texts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_description" TEXT,
    "description" TEXT,

    CONSTRAINT "product_revision_texts_pkey" PRIMARY KEY ("market_id","revision_id","locale")
);

-- CreateTable
CREATE TABLE "catalog"."product_revision_categories" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "product_revision_categories_pkey" PRIMARY KEY ("market_id","revision_id","category_id")
);

-- CreateTable
CREATE TABLE "catalog"."product_revision_variants" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "option_key" TEXT NOT NULL,
    "option_values" JSONB NOT NULL,
    "labels" JSONB NOT NULL,

    CONSTRAINT "product_revision_variants_pkey" PRIMARY KEY ("market_id","revision_id","variant_id")
);

-- CreateTable
CREATE TABLE "catalog"."product_revision_decisions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "publish_kind" TEXT,
    "approval_required_read" BOOLEAN,
    "superseded_cause" TEXT,
    "reason_code" TEXT,
    "reason_text" TEXT,
    "required_checks" TEXT[],
    "confirmed_checks" TEXT[],
    "decided_by_kind" TEXT NOT NULL,
    "decided_by_account_id" UUID,
    "product_version" INTEGER NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_revision_decisions_pkey" PRIMARY KEY ("market_id","revision_id")
);

-- CreateTable
CREATE TABLE "catalog"."rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- CreateIndex
CREATE INDEX "product_working_copies_market_id_last_saved_at_idx" ON "catalog"."product_working_copies"("market_id", "last_saved_at", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_revisions_market_id_product_id_revision_no_key" ON "catalog"."product_revisions"("market_id", "product_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "product_revisions_market_id_id_key" ON "catalog"."product_revisions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_revisions_market_id_product_id_id_key" ON "catalog"."product_revisions"("market_id", "product_id", "id");

-- CreateIndex
CREATE INDEX "product_revision_categories_market_id_category_id_revision__idx" ON "catalog"."product_revision_categories"("market_id", "category_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_variants_market_id_revision_id_option_key_key" ON "catalog"."product_revision_variants"("market_id", "revision_id", "option_key");

-- AddForeignKey
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_market_id_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- AddForeignKey
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_market_id_id_pending_revision_id_fkey" FOREIGN KEY ("market_id", "id", "pending_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- AddForeignKey
ALTER TABLE "catalog"."product_working_copies" ADD CONSTRAINT "product_working_copies_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_working_copies" ADD CONSTRAINT "product_working_copies_market_id_product_id_base_revision__fkey" FOREIGN KEY ("market_id", "product_id", "base_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revisions" ADD CONSTRAINT "product_revisions_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revisions" ADD CONSTRAINT "product_revisions_market_id_product_id_base_revision_id_fkey" FOREIGN KEY ("market_id", "product_id", "base_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revisions" ADD CONSTRAINT "product_revisions_market_id_product_id_reverted_from_revis_fkey" FOREIGN KEY ("market_id", "product_id", "reverted_from_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revisions" ADD CONSTRAINT "product_revisions_market_id_family_revision_id_fkey" FOREIGN KEY ("market_id", "family_revision_id") REFERENCES "catalog"."attribute_family_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_texts" ADD CONSTRAINT "product_revision_texts_market_id_revision_id_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_categories" ADD CONSTRAINT "product_revision_categories_market_id_revision_id_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_categories" ADD CONSTRAINT "product_revision_categories_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_variants" ADD CONSTRAINT "product_revision_variants_market_id_product_id_revision_id_fkey" FOREIGN KEY ("market_id", "product_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_variants" ADD CONSTRAINT "product_revision_variants_market_id_product_id_variant_id_fkey" FOREIGN KEY ("market_id", "product_id", "variant_id") REFERENCES "catalog"."product_variants"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_decisions" ADD CONSTRAINT "product_revision_decisions_market_id_revision_id_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/catalog.md sections 2 (CA1, CA3 to CA6), 3.1,
-- 3.6 to 3.10, 3.12, 3.26, 5.1, 6.1, 7 and 8.2. Constraints on the existing table `products`
-- are added NOT VALID and validated in this file (8.2); every other constraint is on a new table.
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_market_id_id_published_revision_id_fkey";
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_market_id_id_pending_revision_id_fkey";

ALTER TABLE "catalog"."products"
  ADD CONSTRAINT "products_published_revision_check" CHECK (
    "status" NOT IN ('published', 'retired') OR "published_revision_id" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "products_pending_revision_check" CHECK (
    "pending_revision_id" IS NULL OR "pending_revision_id" IS DISTINCT FROM "published_revision_id") NOT VALID,
  ADD CONSTRAINT "products_pending_submitted_check" CHECK (
    ("pending_revision_id" IS NULL) = ("pending_submitted_at" IS NULL)) NOT VALID,
  -- A backstop: a discarded product has no published or pending revision (3.1).
  ADD CONSTRAINT "products_discarded_revision_check" CHECK (
    "status" <> 'discarded' OR ("published_revision_id" IS NULL AND "pending_revision_id" IS NULL)) NOT VALID;
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_published_revision_check";
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_pending_revision_check";
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_pending_submitted_check";
ALTER TABLE "catalog"."products" VALIDATE CONSTRAINT "products_discarded_revision_check";

-- Partial indexes (8.4, 6.1 A5, A6, A9): a revision belongs to one product; the seller list
-- and the review queue. Not CONCURRENTLY: no deployed environment holds products yet (8.2).
CREATE UNIQUE INDEX "products_market_id_published_revision_id_key"
  ON "catalog"."products" ("market_id", "published_revision_id") WHERE "published_revision_id" IS NOT NULL;
CREATE INDEX "products_market_id_owner_seller_id_created_at_idx"
  ON "catalog"."products" ("market_id", "owner_seller_id", "created_at", "id") WHERE "owner_seller_id" IS NOT NULL;
CREATE INDEX "products_market_id_pending_submitted_at_idx"
  ON "catalog"."products" ("market_id", "pending_submitted_at", "id") WHERE "pending_revision_id" IS NOT NULL;

ALTER TABLE "catalog"."product_working_copies"
  ADD CONSTRAINT "product_working_copies_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_working_copies_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_working_copies_content_check" CHECK (jsonb_typeof("content") = 'object'),
  ADD CONSTRAINT "product_working_copies_schema_version_check" CHECK ("content_schema_version" >= 1);

ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "product_revisions_kind_check" CHECK ("revision_kind" IN ('submission', 'revert', 'tax-override')),
  -- A tax override is always the published revision with one field changed (D 4.3, Hassan 1a).
  ADD CONSTRAINT "product_revisions_tax_override_base_check" CHECK (
    "revision_kind" <> 'tax-override' OR "base_revision_id" IS NOT NULL),
  ADD CONSTRAINT "product_revisions_tax_override_author_check" CHECK (
    "revision_kind" <> 'tax-override' OR "author_kind" = 'admin'),
  ADD CONSTRAINT "product_revisions_revert_check" CHECK (
    ("revision_kind" = 'revert') = ("reverted_from_revision_id" IS NOT NULL)),
  ADD CONSTRAINT "product_revisions_tax_category_check" CHECK ("tax_category_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "product_revisions_attribute_values_check" CHECK (jsonb_typeof("attribute_values") = 'object'),
  ADD CONSTRAINT "product_revisions_field_provenance_check" CHECK (
    "field_provenance" IS NULL OR jsonb_typeof("field_provenance") = 'object'),
  -- D 9.2a codes.
  -- Prisma cannot mark a scalar list required, so the lists are NOT NULL by CHECK (Mojtaba B1): a
  -- NULL list would make the checks below evaluate to NULL, which a CHECK accepts.
  ADD CONSTRAINT "product_revisions_definition_revision_ids_check" CHECK (
    "definition_revision_ids" IS NOT NULL AND array_position("definition_revision_ids", NULL) IS NULL),
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'never-published', 'approval-required']::text[]),
  ADD CONSTRAINT "product_revisions_sensitive_check" CHECK (
    "sensitive" OR cardinality("sensitive_reasons") = 0),
  ADD CONSTRAINT "product_revisions_schema_version_check" CHECK ("content_schema_version" >= 1),
  ADD CONSTRAINT "product_revisions_content_hash_check" CHECK ("content_hash" ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "product_revisions_author_kind_check" CHECK ("author_kind" IN ('seller', 'admin')),
  ADD CONSTRAINT "product_revisions_acting_admin_check" CHECK (
    "acting_admin_account_id" IS NULL OR "author_kind" = 'seller');

-- CA5: the S7 class; ZWNJ and ZWJ stay allowed. The description may span lines, so tab, line
-- feed and carriage return are allowed there and nowhere else.
ALTER TABLE "catalog"."product_revision_texts"
  ADD CONSTRAINT "product_revision_texts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_texts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_texts_locale_check" CHECK (
    "locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
  ADD CONSTRAINT "product_revision_texts_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "product_revision_texts_short_description_check" CHECK (
    "short_description" IS NULL OR (
      char_length("short_description") BETWEEN 1 AND 500
      AND "short_description" = btrim("short_description")
      AND "short_description" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]')),
  ADD CONSTRAINT "product_revision_texts_description_check" CHECK (
    "description" IS NULL OR (
      char_length("description") BETWEEN 1 AND 10000
      AND "description" = btrim("description")
      AND "description" !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'));

ALTER TABLE "catalog"."product_revision_categories"
  ADD CONSTRAINT "product_revision_categories_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_categories_position_check" CHECK ("position" >= 0);

ALTER TABLE "catalog"."product_revision_variants"
  ADD CONSTRAINT "product_revision_variants_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_variants_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_variants_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "product_revision_variants_option_key_check" CHECK (char_length("option_key") <= 400),
  ADD CONSTRAINT "product_revision_variants_option_values_check" CHECK (jsonb_typeof("option_values") = 'object'),
  ADD CONSTRAINT "product_revision_variants_labels_check" CHECK (jsonb_typeof("labels") = 'object');

ALTER TABLE "catalog"."product_revision_decisions"
  ADD CONSTRAINT "product_revision_decisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_decisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_decisions_outcome_check" CHECK (
    "outcome" IN ('published', 'changes-requested', 'superseded')),
  ADD CONSTRAINT "product_revision_decisions_publish_kind_check" CHECK (
    "publish_kind" IS NULL OR "publish_kind" IN ('reviewed', 'auto', 'admin-authored')),
  ADD CONSTRAINT "product_revision_decisions_publish_pair_check" CHECK (
    ("outcome" = 'published') = ("publish_kind" IS NOT NULL)),
  ADD CONSTRAINT "product_revision_decisions_auto_read_check" CHECK (
    ("publish_kind" = 'auto') = ("approval_required_read" IS NOT NULL)),
  ADD CONSTRAINT "product_revision_decisions_superseded_cause_check" CHECK (
    "superseded_cause" IS NULL OR "superseded_cause" IN ('resubmitted', 'withdrawn', 'promoted', 'matched')),
  ADD CONSTRAINT "product_revision_decisions_superseded_pair_check" CHECK (
    ("outcome" = 'superseded') = ("superseded_cause" IS NOT NULL)),
  ADD CONSTRAINT "product_revision_decisions_reason_code_check" CHECK (
    "reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "product_revision_decisions_reason_pair_check" CHECK (
    ("outcome" = 'changes-requested') = ("reason_code" IS NOT NULL)),
  -- VER-13: the reviewer's words, clear, and only on a changes request.
  ADD CONSTRAINT "product_revision_decisions_reason_text_check" CHECK (
    "reason_text" IS NULL OR (
      "outcome" = 'changes-requested'
      AND char_length("reason_text") BETWEEN 1 AND 2000
      AND "reason_text" = btrim("reason_text")
      AND "reason_text" !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]')),
  ADD CONSTRAINT "product_revision_decisions_check_arrays_check" CHECK (
    "required_checks" IS NOT NULL AND "confirmed_checks" IS NOT NULL
    AND array_position("required_checks", NULL) IS NULL AND array_position("confirmed_checks", NULL) IS NULL
    AND (cardinality("required_checks") = 0 OR array_to_string("required_checks", ',')
         ~ '^[a-z][a-z0-9_-]{0,63}(,[a-z][a-z0-9_-]{0,63})*$')
    AND (cardinality("confirmed_checks") = 0 OR array_to_string("confirmed_checks", ',')
         ~ '^[a-z][a-z0-9_-]{0,63}(,[a-z][a-z0-9_-]{0,63})*$')),
  -- D 8.3a, Reza 7.6, Hassan H1: a reviewed publish without every required check cannot be stored.
  ADD CONSTRAINT "product_revision_decisions_checks_check" CHECK (
    "publish_kind" IS DISTINCT FROM 'reviewed' OR "required_checks" <@ "confirmed_checks"),
  -- R2: checks are a human's statement on a review, never on an auto-publish.
  ADD CONSTRAINT "product_revision_decisions_confirmed_checks_check" CHECK (
    cardinality("confirmed_checks") = 0 OR "publish_kind" = 'reviewed'),
  ADD CONSTRAINT "product_revision_decisions_decided_by_kind_check" CHECK (
    "decided_by_kind" IN ('admin', 'seller', 'system')),
  ADD CONSTRAINT "product_revision_decisions_decided_by_pair_check" CHECK (
    ("decided_by_kind" = 'system') = ("decided_by_account_id" IS NULL)),
  -- R2 backstop (security review M1): who may record which outcome. A seller only supersedes
  -- (resubmit or withdraw); only the system auto-publishes; a review decision is an admin's.
  ADD CONSTRAINT "product_revision_decisions_actor_outcome_check" CHECK (
    ("decided_by_kind" <> 'seller' OR "outcome" = 'superseded')
    AND ("publish_kind" IS DISTINCT FROM 'auto' OR "decided_by_kind" = 'system')
    AND ("publish_kind" IS NULL OR "publish_kind" = 'auto' OR "decided_by_kind" = 'admin')
    AND ("outcome" <> 'changes-requested' OR "decided_by_kind" = 'admin')),
  ADD CONSTRAINT "product_revision_decisions_product_version_check" CHECK ("product_version" >= 1);

-- Data design 3.26: the sellers shape, with the catalog kinds of D 8.4.
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour')),
  ADD CONSTRAINT "rate_counters_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "rate_counters_count_check" CHECK ("count" >= 0);

-- Data design 3.10: a revision never carries a retired variant (D 4.2 row 6; D 17.1 item 2).
-- SECURITY INVOKER, pinned search_path, schema-qualified names, no dynamic EXECUTE (Ali's Q-K8).
CREATE FUNCTION "catalog"."product_revision_variants_not_retired"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT v.state INTO v_state FROM "catalog"."product_variants" v
   WHERE v.market_id = NEW.market_id AND v.product_id = NEW.product_id AND v.id = NEW.variant_id
     FOR SHARE;
  IF v_state = 'retired' THEN
    RAISE EXCEPTION 'catalog.product_revision_variants: a retired variant cannot join a revision'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "product_revision_variants_not_retired" BEFORE INSERT
  ON "catalog"."product_revision_variants"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."product_revision_variants_not_retired"();

-- CA3 (data design 5.1): the five revision tables are insert-only for every role, the owner
-- included, row and statement level.
CREATE TRIGGER "product_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_texts_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_texts"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_texts_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_texts"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_categories_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_categories"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_categories_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_categories"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_variants_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_variants"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_variants_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_variants"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_decisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_decisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_decisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (database-designer): docs/design/data/catalog.md section 7. The revision tables take SELECT and INSERT only; the working copy is
-- deleted when a draft is discarded or pruned (10.1); counters are purged hourly (3.26).
GRANT UPDATE ("published_revision_id", "pending_revision_id", "pending_submitted_at")
  ON TABLE "catalog"."products" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "catalog"."product_working_copies" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_texts" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_categories" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_variants" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_decisions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "catalog"."rate_counters" TO "mondapac_app";
