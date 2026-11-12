-- Reverses 20261111030000_search_store_documents: the grants, then the trigger and its function,
-- then the table (its indexes and CHECKs go with it).
REVOKE SELECT, INSERT, UPDATE ("slug", "name", "text_search_config", "indexed_at"), DELETE ON TABLE "search"."store_documents" FROM "mondapac_app";

DROP TRIGGER "store_documents_set_vector" ON "search"."store_documents";
DROP FUNCTION "search"."store_documents_set_vector"();
DROP TABLE "search"."store_documents";
