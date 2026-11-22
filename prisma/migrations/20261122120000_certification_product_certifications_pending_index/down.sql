-- Reverses 20261122120000_certification_product_certifications_pending_index. One statement, alone
-- in its file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility
-- check sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "certification"."product_certifications_market_id_pending_idx";
