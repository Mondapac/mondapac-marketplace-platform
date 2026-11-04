SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261103185000_catalog_feature_set_editor. The names are lost; the groups keep their
-- extra keys, which the earlier code ignores.
ALTER TABLE "catalog"."attribute_family_revisions"
  DROP CONSTRAINT "attribute_family_revisions_names_check",
  DROP COLUMN "names";
