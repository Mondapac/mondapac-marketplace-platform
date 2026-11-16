-- Reverses 20261116100001_identity_accounts_pending_email_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "identity"."accounts_market_id_pending_email_requested_at_idx";
