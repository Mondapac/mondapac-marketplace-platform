-- Reverses 20261112150100_search_offer_culture_codes_index. One statement, alone in its file:
-- DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "search"."offer_documents_culture_codes_idx";
