-- Multi-culture package 3a (ADR-0047 decisions 5 and 8): the codes of the cultures an Offer is
-- visible in, written by the indexer from catalog's visibility facade. Existing rows start empty
-- (visible in no culture) and are filled by the attribute reindex, whose catalog stamp now covers
-- the cultures, within minutes of the deploy. No buyer query reads the column before package 3b.
-- The GIN index is built CONCURRENTLY in the next migration
-- (20261112150100_search_offer_culture_codes_index), alone in its file.

-- Safety: a blocked statement fails instead of queueing, and no statement runs unbounded.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable: a constant default, so no table rewrite.
ALTER TABLE "search"."offer_documents"
  ADD COLUMN "culture_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Hand-written: at most 200 codes (the most cultures a Market holds), none null. Added NOT VALID
-- (no scan under the ACCESS EXCLUSIVE lock of ADD CONSTRAINT), then validated on its own, which
-- scans under SHARE UPDATE EXCLUSIVE and lets writes go on.
ALTER TABLE "search"."offer_documents"
  ADD CONSTRAINT "offer_documents_culture_codes_check" CHECK (
    cardinality("culture_codes") <= 200 AND array_position("culture_codes", NULL) IS NULL) NOT VALID;

-- Grants. Written by the indexer like the other derived columns.
GRANT UPDATE ("culture_codes") ON TABLE "search"."offer_documents" TO "mondapac_app";

ALTER TABLE "search"."offer_documents" VALIDATE CONSTRAINT "offer_documents_culture_codes_check";
