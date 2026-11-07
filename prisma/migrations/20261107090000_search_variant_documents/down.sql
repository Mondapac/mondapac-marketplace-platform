-- Reverses 20261107090000_search_variant_documents: the grants, then the table (its index, CHECKs
-- and foreign key go with it).
REVOKE SELECT, INSERT, DELETE ON TABLE "search"."offer_variant_documents" FROM "mondapac_app";
DROP TABLE "search"."offer_variant_documents";
