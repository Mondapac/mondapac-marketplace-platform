-- Reverses 20261112170002_catalog_offers_shelf_index. One statement, alone in its file: DROP
-- INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check sends a
-- down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "catalog"."offers_market_id_shelf_category_id_idx";
