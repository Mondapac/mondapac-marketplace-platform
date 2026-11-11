-- Reverses 20261107010000_catalog_variant_types (docs/design/data/catalog.md 8.3).
-- Development and CI only: the variant type settings are lost.
REVOKE SELECT, INSERT ON TABLE "catalog"."variant_type_setting_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("current_revision_id", "version")
  ON TABLE "catalog"."variant_type_settings" FROM "mondapac_app";
ALTER TABLE "catalog"."variant_type_settings"
  DROP CONSTRAINT "variant_type_settings_market_id_definition_id_current_revi_fkey";
DROP INDEX "catalog"."product_revision_variants_market_id_variant_id_idx";
DROP TABLE "catalog"."variant_type_setting_revisions";
DROP TABLE "catalog"."variant_type_settings";
