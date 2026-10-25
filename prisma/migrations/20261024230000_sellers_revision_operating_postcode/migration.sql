-- The clear postcode of a revision's operating address (SHP-02/03): the pickup postcode the
-- real-time carrier quotes from at checkout, so a quote opens no sealed content. Copied at
-- submission like service_area_code; NULL for a revision written before this column (the
-- seller's orders then keep the flat fee). Immutable: the app role gets no UPDATE on it.

-- AlterTable
ALTER TABLE "sellers"."business_file_revisions" ADD COLUMN     "operating_postcode" TEXT;

ALTER TABLE "sellers"."business_file_revisions"
  ADD CONSTRAINT "business_file_revisions_operating_postcode_check" CHECK (
    "operating_postcode" IS NULL OR "operating_postcode" ~ '^[0-9A-Za-z -]{1,16}$');
