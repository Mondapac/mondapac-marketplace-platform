-- Reverses 20261027191500_commission_payouts_ledger_order_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "commission_payouts"."ledger_entries_market_id_order_id_idx";
