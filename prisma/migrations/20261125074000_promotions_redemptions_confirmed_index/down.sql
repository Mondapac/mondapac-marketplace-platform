-- Reverses 20261125074000_promotions_redemptions_confirmed_index. One statement, alone in its
-- file: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the reversibility check
-- sends a down file as one query, so there is no SET lock_timeout here.
DROP INDEX CONCURRENTLY "promotions"."redemptions_confirmed_idx";
