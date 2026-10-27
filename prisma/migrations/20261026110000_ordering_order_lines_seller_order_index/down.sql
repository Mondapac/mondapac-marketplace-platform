-- Reverses 20261026110000_ordering_order_lines_seller_order_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "ordering"."order_lines_market_id_seller_order_id_idx";
