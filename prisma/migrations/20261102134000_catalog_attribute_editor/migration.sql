SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "catalog"."attribute_definition_revision_options" ADD COLUMN     "merged_into" TEXT;

-- AlterTable
ALTER TABLE "catalog"."attribute_definition_revisions" ADD COLUMN     "can_be_filter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "help_text" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "internal_note" TEXT,
ADD COLUMN     "position" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "searchable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "show_on_product_page" BOOLEAN NOT NULL DEFAULT true;

-- Hand-written (database-designer): attributes package A2. A definition may be a draft until it
-- is published; a draft is never named by a family or a product revision (the schema builder
-- refuses a definition that is not active). The new revision columns are insert-only like the
-- rest of the row (the existing no-update trigger covers every column).
ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_status_check",
  ADD CONSTRAINT "attribute_definitions_status_check" CHECK ("status" IN ('draft', 'active', 'archived'));

ALTER TABLE "catalog"."attribute_definition_revisions"
  ADD CONSTRAINT "attribute_definition_revisions_help_text_check" CHECK (jsonb_typeof("help_text") = 'object'),
  ADD CONSTRAINT "attribute_definition_revisions_internal_note_check" CHECK (
    "internal_note" IS NULL OR char_length("internal_note") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "attribute_definition_revisions_position_check" CHECK ("position" >= 0);

ALTER TABLE "catalog"."attribute_definition_revision_options"
  ADD CONSTRAINT "attribute_definition_revision_options_merged_into_check" CHECK (
    "merged_into" IS NULL OR ("merged_into" ~ '^[a-z][a-z0-9_-]{0,63}$' AND "merged_into" <> "option_code"));

-- Hand-written (database-designer review of #649): a value is merged only into another value of the
-- same revision. Checked at the end of the statement, so one createMany may hold both rows; a
-- null merged_into is not checked (MATCH SIMPLE). The column is new and empty, so no NOT VALID.
ALTER TABLE "catalog"."attribute_definition_revision_options"
  ADD CONSTRAINT "attribute_definition_revision_options_merged_into_fkey"
  FOREIGN KEY ("market_id", "revision_id", "merged_into")
  REFERENCES "catalog"."attribute_definition_revision_options"("market_id", "revision_id", "option_code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
