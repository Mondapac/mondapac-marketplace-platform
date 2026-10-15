-- Reverses 20261015180000_search_offer_documents: the grants first, then the trigger and its
-- function, then the table. Indexes and CHECKs go with the table. The empty schema "search"
-- stays, without its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5
-- (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("product_id", "seller_id", "locale", "name", "short_text", "category_ids", "text_search_config", "indexed_at"), DELETE ON TABLE "search"."offer_documents" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "search" FROM "mondapac_app";

DROP TRIGGER "offer_documents_set_vector" ON "search"."offer_documents";
DROP FUNCTION "search"."offer_documents_set_vector"();
DROP TABLE "search"."offer_documents";
