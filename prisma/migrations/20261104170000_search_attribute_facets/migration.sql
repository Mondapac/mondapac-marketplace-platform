-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable: the attribute facts of a document (attributes A7), all derived by the indexer.
ALTER TABLE "search"."offer_documents"
  ADD COLUMN "search_text" TEXT,
  ADD COLUMN "facet_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable: the numbers of a document a range filter reads (one row per attribute).
CREATE TABLE "search"."offer_document_numbers" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "attr" TEXT NOT NULL,
    "value" DECIMAL(24,9) NOT NULL,

    CONSTRAINT "offer_document_numbers_pkey" PRIMARY KEY ("market_id","offer_id","attr")
);

-- CreateIndex
CREATE INDEX "offer_document_numbers_market_id_attr_value_idx" ON "search"."offer_document_numbers"("market_id", "attr", "value");

-- AddForeignKey: a number lives and dies with its document (a projection, never a source of truth).
ALTER TABLE "search"."offer_document_numbers" ADD CONSTRAINT "offer_document_numbers_market_id_offer_id_fkey" FOREIGN KEY ("market_id", "offer_id") REFERENCES "search"."offer_documents"("market_id", "offer_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- CreateTable: one row per Market, the progress of the attribute reindex.
CREATE TABLE "search"."reindex_state" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "done_stamp" TEXT,
    "target_stamp" TEXT,
    "status" TEXT NOT NULL,
    "offers_done" INTEGER NOT NULL,
    "cursor_offer_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "failure" TEXT,

    CONSTRAINT "reindex_state_pkey" PRIMARY KEY ("market_id")
);

-- Hand-written: value checks.
ALTER TABLE "search"."offer_documents"
  ADD CONSTRAINT "offer_documents_search_text_check" CHECK (
    "search_text" IS NULL OR char_length("search_text") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "offer_documents_facet_codes_check" CHECK (
    cardinality("facet_codes") <= 100 AND array_position("facet_codes", NULL) IS NULL);

ALTER TABLE "search"."offer_document_numbers"
  ADD CONSTRAINT "offer_document_numbers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_document_numbers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_document_numbers_attr_check" CHECK ("attr" ~ '^[a-z][a-z0-9_-]{0,63}$');

ALTER TABLE "search"."reindex_state"
  ADD CONSTRAINT "reindex_state_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "reindex_state_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "reindex_state_status_check" CHECK ("status" IN ('idle', 'running', 'failed')),
  ADD CONSTRAINT "reindex_state_offers_done_check" CHECK ("offers_done" >= 0),
  ADD CONSTRAINT "reindex_state_failure_check" CHECK ("failure" IS NULL OR char_length("failure") <= 200);

-- Hand-written: the facet index (an option, a brand or a country is `attribute=value`; a filter
-- asks for a document holding one of the values). Invisible to Prisma.
CREATE INDEX "offer_documents_facet_codes_idx" ON "search"."offer_documents" USING GIN ("facet_codes");

-- Hand-written: the vector now also holds the searchable attribute values, below the name (A) and
-- the short text (B), at weight C. The same trigger, replaced in place.
CREATE OR REPLACE FUNCTION "search"."offer_documents_set_vector"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector(NEW."text_search_config"::regconfig, NEW."name"), 'A')
    || setweight(to_tsvector(NEW."text_search_config"::regconfig, coalesce(NEW."short_text", '')), 'B')
    || setweight(to_tsvector(NEW."text_search_config"::regconfig, coalesce(NEW."search_text", '')), 'C');
  RETURN NEW;
END; $$;

-- Grants. The new columns are written by the indexer like the others; the progress row is
-- written by the reindex job only and never deleted.
GRANT UPDATE ("search_text", "facet_codes") ON TABLE "search"."offer_documents" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "search"."offer_document_numbers" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("done_stamp", "target_stamp", "status", "offers_done", "cursor_offer_id", "started_at", "updated_at", "finished_at", "failure") ON TABLE "search"."reindex_state" TO "mondapac_app";
