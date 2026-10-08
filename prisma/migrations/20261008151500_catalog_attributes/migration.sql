-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "catalog"."attribute_definitions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,
    "localizable" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "published_revision_id" UUID,
    "created_by_kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."attribute_definition_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "material" BOOLEAN NOT NULL,
    "is_variant_option" BOOLEAN NOT NULL,
    "bounds" JSONB NOT NULL,
    "names" JSONB NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_account_id" UUID,
    "relaxation_request_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_definition_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."attribute_definition_revision_options" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "option_code" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "attribute_definition_revision_options_pkey" PRIMARY KEY ("market_id","revision_id","option_code")
);

-- CreateTable
CREATE TABLE "catalog"."attribute_families" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "published_revision_id" UUID,
    "created_by_kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."attribute_family_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "groups" JSONB NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_account_id" UUID,
    "relaxation_request_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_family_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_market_id_id_key" ON "catalog"."attribute_definitions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_market_id_code_key" ON "catalog"."attribute_definitions"("market_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definition_revisions_market_id_definition_id_revi_key" ON "catalog"."attribute_definition_revisions"("market_id", "definition_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definition_revisions_market_id_definition_id_id_key" ON "catalog"."attribute_definition_revisions"("market_id", "definition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definition_revisions_market_id_id_key" ON "catalog"."attribute_definition_revisions"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_families_market_id_id_key" ON "catalog"."attribute_families"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_families_market_id_code_key" ON "catalog"."attribute_families"("market_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_family_revisions_market_id_family_id_revision_no_key" ON "catalog"."attribute_family_revisions"("market_id", "family_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_family_revisions_market_id_family_id_id_key" ON "catalog"."attribute_family_revisions"("market_id", "family_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_family_revisions_market_id_id_key" ON "catalog"."attribute_family_revisions"("market_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."attribute_definitions" ADD CONSTRAINT "attribute_definitions_market_id_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "catalog"."attribute_definition_revisions"("market_id", "definition_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_definition_revisions" ADD CONSTRAINT "attribute_definition_revisions_market_id_definition_id_fkey" FOREIGN KEY ("market_id", "definition_id") REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_definition_revision_options" ADD CONSTRAINT "attribute_definition_revision_options_market_id_revision_i_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."attribute_definition_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_families" ADD CONSTRAINT "attribute_families_market_id_id_published_revision_id_fkey" FOREIGN KEY ("market_id", "id", "published_revision_id") REFERENCES "catalog"."attribute_family_revisions"("market_id", "family_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_family_revisions" ADD CONSTRAINT "attribute_family_revisions_market_id_family_id_fkey" FOREIGN KEY ("market_id", "family_id") REFERENCES "catalog"."attribute_families"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): docs/design/data/catalog.md sections 2 (CA1, CA3, CA4, CA6),
-- 3.5, 5.1 and 7. Only new tables, so nothing here is NOT VALID. The relaxation_request_id
-- columns carry no foreign key yet and the two-person triggers do not exist yet: both arrive
-- with slice 21 (data design 8.1 row 13).
ALTER TABLE "catalog"."attribute_definitions"
  ADD CONSTRAINT "attribute_definitions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_definitions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_definitions_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "attribute_definitions_data_type_check" CHECK ("data_type" IN
    ('text', 'long-text', 'integer', 'decimal', 'boolean', 'select', 'multi-select', 'date')),
  ADD CONSTRAINT "attribute_definitions_status_check" CHECK ("status" IN ('active', 'archived')),
  ADD CONSTRAINT "attribute_definitions_created_by_kind_check" CHECK ("created_by_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "attribute_definitions_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."attribute_definition_revisions"
  ADD CONSTRAINT "attribute_definition_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_definition_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_definition_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "attribute_definition_revisions_bounds_check" CHECK (jsonb_typeof("bounds") = 'object'),
  ADD CONSTRAINT "attribute_definition_revisions_names_check" CHECK (
    jsonb_typeof("names") = 'object' AND "names" <> '{}'::jsonb),
  ADD CONSTRAINT "attribute_definition_revisions_author_kind_check" CHECK ("author_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "attribute_definition_revisions_author_check" CHECK (
    ("author_kind" = 'seed') = ("author_account_id" IS NULL));

ALTER TABLE "catalog"."attribute_definition_revision_options"
  ADD CONSTRAINT "attribute_definition_revision_options_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_definition_revision_options_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_definition_revision_options_option_code_check" CHECK ("option_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "attribute_definition_revision_options_labels_check" CHECK (
    jsonb_typeof("labels") = 'object' AND "labels" <> '{}'::jsonb),
  ADD CONSTRAINT "attribute_definition_revision_options_position_check" CHECK ("position" >= 0);

ALTER TABLE "catalog"."attribute_families"
  ADD CONSTRAINT "attribute_families_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_families_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_families_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "attribute_families_status_check" CHECK ("status" IN ('active', 'archived')),
  ADD CONSTRAINT "attribute_families_created_by_kind_check" CHECK ("created_by_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "attribute_families_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."attribute_family_revisions"
  ADD CONSTRAINT "attribute_family_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_family_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_family_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "attribute_family_revisions_groups_check" CHECK (jsonb_typeof("groups") = 'array'),
  ADD CONSTRAINT "attribute_family_revisions_author_kind_check" CHECK ("author_kind" IN ('seed', 'admin')),
  ADD CONSTRAINT "attribute_family_revisions_author_check" CHECK (
    ("author_kind" = 'seed') = ("author_account_id" IS NULL));

-- CA3 (data design 5.1): the three revision tables are insert-only for every role, the owner
-- included, row and statement level.
CREATE TRIGGER "attribute_definition_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."attribute_definition_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_definition_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_definition_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_definition_revision_options_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."attribute_definition_revision_options"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_definition_revision_options_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_definition_revision_options"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_family_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."attribute_family_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_family_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_family_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (data design 7): no DELETE anywhere; code, data type, localizable flag and creator kind
-- never change. "Delete" of a definition or family means archive (slice 21).
GRANT SELECT, INSERT, UPDATE ("status", "published_revision_id", "version")
  ON TABLE "catalog"."attribute_definitions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."attribute_definition_revisions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."attribute_definition_revision_options" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "published_revision_id", "version")
  ON TABLE "catalog"."attribute_families" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."attribute_family_revisions" TO "mondapac_app";
