-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "catalog"."category_trees" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "category_trees_pkey" PRIMARY KEY ("market_id")
);

-- CreateTable
CREATE TABLE "catalog"."platform_categories" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "parent_id" UUID,
    "vertical_root_code" TEXT,
    "slug" TEXT COLLATE "C" NOT NULL,
    "status" TEXT NOT NULL,
    "merged_into_id" UUID,
    "published_revision_id" UUID,
    "created_by_kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."platform_category_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "parent_id" UUID,
    "change_kind" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_account_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_category_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."platform_category_revision_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "platform_category_revision_names_pkey" PRIMARY KEY ("market_id","revision_id","locale")
);

-- CreateIndex
CREATE INDEX "platform_categories_market_id_parent_id_idx" ON "catalog"."platform_categories"("market_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_categories_market_id_id_key" ON "catalog"."platform_categories"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_categories_market_id_slug_key" ON "catalog"."platform_categories"("market_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "platform_category_revisions_market_id_category_id_revision__key" ON "catalog"."platform_category_revisions"("market_id", "category_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "platform_category_revisions_market_id_category_id_id_key" ON "catalog"."platform_category_revisions"("market_id", "category_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_category_revisions_market_id_id_key" ON "catalog"."platform_category_revisions"("market_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."platform_categories" ADD CONSTRAINT "platform_categories_market_id_parent_id_fkey" FOREIGN KEY ("market_id", "parent_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."platform_categories" ADD CONSTRAINT "platform_categories_market_id_merged_into_id_fkey" FOREIGN KEY ("market_id", "merged_into_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."platform_categories" ADD CONSTRAINT "platform_categories_market_id_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "catalog"."platform_category_revisions"("market_id", "category_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."platform_category_revisions" ADD CONSTRAINT "platform_category_revisions_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."platform_category_revision_names" ADD CONSTRAINT "platform_category_revision_names_market_id_revision_id_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."platform_category_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): docs/design/data/catalog.md sections 2 (CA1, CA3 to CA6), 3.4,
-- 5.1 and 7. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "catalog"."category_trees"
  ADD CONSTRAINT "category_trees_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_trees_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_trees_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_categories_parent_not_self_check" CHECK ("parent_id" <> "id"),
  ADD CONSTRAINT "platform_categories_vertical_root_code_check" CHECK (
    "vertical_root_code" IS NULL
    OR ("vertical_root_code" ~ '^[a-z][a-z0-9_-]{0,63}$' AND "parent_id" IS NULL)),
  ADD CONSTRAINT "platform_categories_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 80),
  ADD CONSTRAINT "platform_categories_status_check" CHECK ("status" IN ('active', 'merged', 'archived')),
  ADD CONSTRAINT "platform_categories_merged_check" CHECK (
    ("status" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "platform_categories_merged_not_self_check" CHECK ("merged_into_id" <> "id"),
  ADD CONSTRAINT "platform_categories_created_by_kind_check" CHECK ("created_by_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "platform_categories_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."platform_category_revisions"
  ADD CONSTRAINT "platform_category_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_category_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_category_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "platform_category_revisions_change_kind_check" CHECK (
    "change_kind" IN ('created', 'renamed', 'moved', 'merged', 'archived')),
  ADD CONSTRAINT "platform_category_revisions_author_kind_check" CHECK ("author_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "platform_category_revisions_author_check" CHECK (
    ("author_kind" = 'seed') = ("author_account_id" IS NULL));

ALTER TABLE "catalog"."platform_category_revision_names"
  ADD CONSTRAINT "platform_category_revision_names_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_category_revision_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_category_revision_names_locale_check" CHECK (
    "locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
  -- CA5: the S7 class; ZWNJ and ZWJ stay allowed (the joining-script rule is PlainText's).
  ADD CONSTRAINT "platform_category_revision_names_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 120
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]');

-- Data design 5.1 (Ali's Q-K8 rules: SECURITY INVOKER, pinned search_path, schema-qualified names,
-- no dynamic EXECUTE). The body is the one run on the throwaway cluster of data design 11.
CREATE FUNCTION "catalog"."platform_categories_no_cycle"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur uuid := NEW.parent_id; depth integer := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'catalog.platform_categories: cycle' USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth >= 64 THEN
      RAISE EXCEPTION 'catalog.platform_categories: depth cap 64 reached' USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.parent_id INTO cur FROM "catalog"."platform_categories" c
     WHERE c.market_id = NEW.market_id AND c.id = cur;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER "platform_categories_no_cycle" BEFORE INSERT OR UPDATE OF "parent_id"
  ON "catalog"."platform_categories" FOR EACH ROW EXECUTE FUNCTION "catalog"."platform_categories_no_cycle"();

-- CA3 (data design 5.1): the revisions and their names are insert-only for every role, the owner
-- included, row and statement level.
CREATE TRIGGER "platform_category_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."platform_category_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."platform_category_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_revision_names_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."platform_category_revision_names"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_revision_names_no_truncate" BEFORE TRUNCATE
  ON "catalog"."platform_category_revision_names"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (data design 7): no DELETE anywhere; the slug and the creator kind never change.
GRANT SELECT, INSERT, UPDATE ("version") ON TABLE "catalog"."category_trees" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("parent_id", "status", "merged_into_id", "published_revision_id", "version")
  ON TABLE "catalog"."platform_categories" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."platform_category_revisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."platform_category_revision_names" TO "mondapac_app";
