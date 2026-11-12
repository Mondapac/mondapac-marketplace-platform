-- Reverses 20261112150000_search_offer_culture_codes: the grant, the CHECK, the column (the index
-- is dropped by the down of 20261112150100 first). The culture codes are a projection; a later up
-- rebuilds them through the attribute reindex.
SET lock_timeout = '5s';

REVOKE UPDATE ("culture_codes") ON TABLE "search"."offer_documents" FROM "mondapac_app";
ALTER TABLE "search"."offer_documents"
  DROP CONSTRAINT "offer_documents_culture_codes_check",
  DROP COLUMN "culture_codes";
