-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Slice 6, the admin seller list (data design 7, query A4; 9.1 migration 7). The "Incomplete" tab
-- reads the files that were never approved, most recently changed first, by keyset on
-- (last_changed_at, seller_id); the purge (10.1) reads the same files. Partial: it holds only the
-- rows whose approved pointer is NULL, which shrinks as sellers are approved. Hand-written
-- because Prisma cannot declare a partial index; the drift check ignores it as it does the
-- other partial indexes of this module.
--
-- Plain CREATE INDEX, not CONCURRENTLY: no deployed environment holds sellers rows (9.3), so
-- the build blocks nothing. A deployed environment would use CONCURRENTLY alone in its file.
CREATE INDEX "seller_files_market_id_last_changed_at_seller_id_unapproved_idx" ON "sellers"."seller_files" ("market_id", "last_changed_at", "seller_id") WHERE "approved_revision_id" IS NULL;
