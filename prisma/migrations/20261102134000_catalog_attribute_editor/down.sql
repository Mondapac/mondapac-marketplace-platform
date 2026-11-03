SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261102134000_catalog_attribute_editor. A draft definition cannot be represented by
-- the earlier schema, so the status check is restored only when none exists (it fails otherwise:
-- archive or publish the drafts first).
ALTER TABLE "catalog"."attribute_definition_revision_options"
  DROP CONSTRAINT "attribute_definition_revision_options_merged_into_fkey",
  DROP CONSTRAINT "attribute_definition_revision_options_merged_into_check",
  DROP COLUMN "merged_into";

ALTER TABLE "catalog"."attribute_definition_revisions"
  DROP CONSTRAINT "attribute_definition_revisions_help_text_check",
  DROP CONSTRAINT "attribute_definition_revisions_internal_note_check",
  DROP CONSTRAINT "attribute_definition_revisions_position_check",
  DROP COLUMN "can_be_filter",
  DROP COLUMN "help_text",
  DROP COLUMN "internal_note",
  DROP COLUMN "position",
  DROP COLUMN "searchable",
  DROP COLUMN "show_on_product_page";

ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_status_check",
  ADD CONSTRAINT "attribute_definitions_status_check" CHECK ("status" IN ('active', 'archived'));
