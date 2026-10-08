-- Reverses 20261008121500_catalog_attributes (docs/design/data/catalog.md 8.3): the grants
-- first, then the triggers, then the tables, children before parents. The roots and their
-- revisions point at each other (revision to root, root to published revision), so the second
-- foreign key is dropped first. CHECKs and indexes go with their tables.
REVOKE SELECT, INSERT ON TABLE "catalog"."attribute_family_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "published_revision_id", "version")
  ON TABLE "catalog"."attribute_families" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."attribute_definition_revision_options" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."attribute_definition_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "published_revision_id", "version")
  ON TABLE "catalog"."attribute_definitions" FROM "mondapac_app";
DROP TRIGGER "attribute_family_revisions_no_truncate" ON "catalog"."attribute_family_revisions";
DROP TRIGGER "attribute_family_revisions_no_update_delete" ON "catalog"."attribute_family_revisions";
DROP TRIGGER "attribute_definition_revision_options_no_truncate" ON "catalog"."attribute_definition_revision_options";
DROP TRIGGER "attribute_definition_revision_options_no_update_delete" ON "catalog"."attribute_definition_revision_options";
DROP TRIGGER "attribute_definition_revisions_no_truncate" ON "catalog"."attribute_definition_revisions";
DROP TRIGGER "attribute_definition_revisions_no_update_delete" ON "catalog"."attribute_definition_revisions";
ALTER TABLE "catalog"."attribute_families"
  DROP CONSTRAINT "attribute_families_market_id_id_published_revision_id_fkey";
ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_market_id_id_published_revision_id_fkey";
DROP TABLE "catalog"."attribute_family_revisions";
DROP TABLE "catalog"."attribute_families";
DROP TABLE "catalog"."attribute_definition_revision_options";
DROP TABLE "catalog"."attribute_definition_revisions";
DROP TABLE "catalog"."attribute_definitions";
