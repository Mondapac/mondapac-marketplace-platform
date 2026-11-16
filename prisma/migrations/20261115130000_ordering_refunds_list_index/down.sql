-- Reverses 20261115130000_ordering_refunds_list_index. One statement, alone in its file: DROP
-- INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check sends a
-- down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."refunds_market_id_requested_at_id_idx";
