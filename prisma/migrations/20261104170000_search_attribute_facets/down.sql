-- Reverses 20261104170000_search_attribute_facets: the grants, the table, the trigger function as
-- it was (name and short text only), then the columns and their index and CHECKs.
REVOKE SELECT, INSERT, UPDATE ("done_stamp", "target_stamp", "status", "offers_done", "cursor_offer_id", "started_at", "updated_at", "finished_at", "failure") ON TABLE "search"."reindex_state" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "search"."offer_document_numbers" FROM "mondapac_app";
REVOKE UPDATE ("search_text", "facet_codes") ON TABLE "search"."offer_documents" FROM "mondapac_app";

DROP TABLE "search"."reindex_state";
DROP TABLE "search"."offer_document_numbers";

CREATE OR REPLACE FUNCTION "search"."offer_documents_set_vector"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector(NEW."text_search_config"::regconfig, NEW."name"), 'A')
    || setweight(to_tsvector(NEW."text_search_config"::regconfig, coalesce(NEW."short_text", '')), 'B');
  RETURN NEW;
END; $$;

DROP INDEX "search"."offer_documents_facet_codes_idx";
ALTER TABLE "search"."offer_documents"
  DROP CONSTRAINT "offer_documents_search_text_check",
  DROP CONSTRAINT "offer_documents_facet_codes_check",
  DROP COLUMN "search_text",
  DROP COLUMN "facet_codes";
