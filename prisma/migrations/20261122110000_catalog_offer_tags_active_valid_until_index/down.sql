-- Reverses 20261122110000_catalog_offer_tags_active_valid_until_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "catalog"."offer_tags_market_id_valid_until_active_idx";
