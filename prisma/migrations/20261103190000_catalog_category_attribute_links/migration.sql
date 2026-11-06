SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."category_attribute_links" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "published_revision_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_attribute_links_pkey" PRIMARY KEY ("market_id","category_id")
);

-- CreateTable
CREATE TABLE "catalog"."category_attribute_link_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "family_id" UUID,
    "filters" JSONB NOT NULL,
    "author_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_attribute_link_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_attribute_link_revisions_market_id_category_id_rev_key" ON "catalog"."category_attribute_link_revisions"("market_id", "category_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "category_attribute_link_revisions_market_id_category_id_id_key" ON "catalog"."category_attribute_link_revisions"("market_id", "category_id", "id");

-- CreateIndex
CREATE INDEX "category_attribute_link_revisions_market_id_family_id_idx" ON "catalog"."category_attribute_link_revisions"("market_id", "family_id");

-- AddForeignKey
ALTER TABLE "catalog"."category_attribute_links" ADD CONSTRAINT "category_attribute_links_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_attribute_links" ADD CONSTRAINT "category_attribute_links_market_id_category_id_published_r_fkey" FOREIGN KEY ("market_id", "category_id", "published_revision_id") REFERENCES "catalog"."category_attribute_link_revisions"("market_id", "category_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_attribute_link_revisions" ADD CONSTRAINT "category_attribute_link_revisions_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."category_attribute_links"("market_id", "category_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_attribute_link_revisions" ADD CONSTRAINT "category_attribute_link_revisions_market_id_family_id_fkey" FOREIGN KEY ("market_id", "family_id") REFERENCES "catalog"."attribute_families"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): attributes package A4 (categories C8). A category's feature set
-- and ordered filter list, kept as insert-only revisions behind a root that holds the pointer and
-- the version, like a family. A null family means "inherited from the parent" (the use case
-- resolves it); the filters are attribute codes in order, a document read whole. Nothing is
-- deleted: a link is replaced by a new revision.
ALTER TABLE "catalog"."category_attribute_links"
  ADD CONSTRAINT "category_attribute_links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_attribute_links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_attribute_links_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."category_attribute_link_revisions"
  ADD CONSTRAINT "category_attribute_link_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_attribute_link_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_attribute_link_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "category_attribute_link_revisions_filters_check" CHECK (
    jsonb_typeof("filters") = 'array' AND jsonb_array_length("filters") <= 20);

CREATE TRIGGER "category_attribute_link_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."category_attribute_link_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "category_attribute_link_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."category_attribute_link_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

GRANT SELECT, INSERT, UPDATE ("published_revision_id", "version")
  ON TABLE "catalog"."category_attribute_links" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."category_attribute_link_revisions" TO "mondapac_app";
