-- Reverses 20261008150000_sellers_draft_slug (docs/design/data/sellers.md 9.4): the CHECK, then
-- the column. For an empty or development database only: it drops the column and its data.
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_draft_slug_check";
ALTER TABLE "sellers"."seller_files" DROP COLUMN "draft_slug";
