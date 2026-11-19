-- Variants management V6 (plan section 9, decision tn1): the admin Catalogue > Variants page.
-- `variant_type_settings` and its insert-only `variant_type_setting_revisions`: how buyers
-- choose one variant type (an attribute with `is_variant_option`): the display style, the
-- option order, a swatch colour per option and one help sentence per locale for sellers. A
-- root holds the pointer to the current revision and the version a write names, like a
-- category's attribute links (A4). A variant type without a root uses the defaults.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."variant_type_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_type_settings_pkey" PRIMARY KEY ("market_id","definition_id")
);

-- CreateTable
CREATE TABLE "catalog"."variant_type_setting_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "display_style" TEXT NOT NULL,
    "option_order" TEXT NOT NULL,
    "swatches" JSONB NOT NULL,
    "seller_help" JSONB NOT NULL,
    "author_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_type_setting_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "variant_type_setting_revisions_market_id_definition_id_revi_key" ON "catalog"."variant_type_setting_revisions"("market_id", "definition_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "variant_type_setting_revisions_market_id_definition_id_id_key" ON "catalog"."variant_type_setting_revisions"("market_id", "definition_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."variant_type_settings" ADD CONSTRAINT "variant_type_settings_market_id_definition_id_fkey" FOREIGN KEY ("market_id", "definition_id") REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."variant_type_settings" ADD CONSTRAINT "variant_type_settings_market_id_definition_id_current_revi_fkey" FOREIGN KEY ("market_id", "definition_id", "current_revision_id") REFERENCES "catalog"."variant_type_setting_revisions"("market_id", "definition_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."variant_type_setting_revisions" ADD CONSTRAINT "variant_type_setting_revisions_market_id_definition_id_fkey" FOREIGN KEY ("market_id", "definition_id") REFERENCES "catalog"."variant_type_settings"("market_id", "definition_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): closed lists, bounds and the shapes of the two documents. The
-- domain checks each entry (an option code of the type to `#RRGGBB`; a supported locale to one
-- sentence of at most 200 characters); the CHECKs bound the shape and the size.
ALTER TABLE "catalog"."variant_type_settings"
  ADD CONSTRAINT "variant_type_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "variant_type_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "variant_type_settings_version_check" CHECK ("version" >= 1);
ALTER TABLE "catalog"."variant_type_setting_revisions"
  ADD CONSTRAINT "variant_type_setting_revisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "variant_type_setting_revisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "variant_type_setting_revisions_revision_no_check" CHECK ("revision_no" >= 1),
  ADD CONSTRAINT "variant_type_setting_revisions_display_style_check" CHECK (
    "display_style" IN ('buttons', 'swatches', 'dropdown')),
  ADD CONSTRAINT "variant_type_setting_revisions_option_order_check" CHECK (
    "option_order" IN ('manual', 'alphabetical', 'by-size')),
  ADD CONSTRAINT "variant_type_setting_revisions_swatches_check" CHECK (
    jsonb_typeof("swatches") = 'object' AND octet_length("swatches"::text) <= 16384),
  ADD CONSTRAINT "variant_type_setting_revisions_seller_help_check" CHECK (
    jsonb_typeof("seller_help") = 'object' AND octet_length("seller_help"::text) <= 8192);

CREATE TRIGGER "variant_type_setting_revisions_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."variant_type_setting_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "variant_type_setting_revisions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."variant_type_setting_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants: the root's pointer and version move, a revision never changes. Nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("current_revision_id", "version")
  ON TABLE "catalog"."variant_type_settings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."variant_type_setting_revisions" TO "mondapac_app";

-- The admin Variants page pages the variants of live products newest first by variant id (V6).
CREATE INDEX "product_revision_variants_market_id_variant_id_idx"
  ON "catalog"."product_revision_variants"("market_id", "variant_id");
