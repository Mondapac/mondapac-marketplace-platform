-- Multi-culture package 3a (ADR-0047 decisions 5 and 8): the codes of the cultures an Offer is
-- visible in, written by the indexer from catalog's visibility facade. Existing rows start empty
-- (visible in no culture) and are filled by the attribute reindex, whose catalog stamp now covers
-- the cultures, within minutes of the deploy. No buyer query reads the column before package 3b.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable: a constant default, so no table rewrite.
ALTER TABLE "search"."offer_documents"
  ADD COLUMN "culture_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Hand-written: at most 200 codes (the most cultures a Market holds), none null.
ALTER TABLE "search"."offer_documents"
  ADD CONSTRAINT "offer_documents_culture_codes_check" CHECK (
    cardinality("culture_codes") <= 200 AND array_position("culture_codes", NULL) IS NULL);

-- CreateIndex: the culture filter of package 3b asks for documents holding one of the chosen codes.
CREATE INDEX "offer_documents_culture_codes_idx" ON "search"."offer_documents" USING GIN ("culture_codes");

-- Grants. Written by the indexer like the other derived columns.
GRANT UPDATE ("culture_codes") ON TABLE "search"."offer_documents" TO "mondapac_app";
