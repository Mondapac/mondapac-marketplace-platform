-- Safety (docs/design/data/sellers.md 9.3): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable (nullable, no default: a catalog change, no rewrite; 9.3). draft_slug is COLLATE "C"
-- by hand (S6; Prisma does not see a column collation, spike S1). The draft's chosen shop slug
-- (Q-M25): clear, not public while a draft; no unique key and no index, because uniqueness is
-- decided only when the first submission holds the slug in shop_slugs (T1).
ALTER TABLE "sellers"."seller_files" ADD COLUMN "draft_slug" TEXT COLLATE "C";

-- Hand-written (database-designer): the rule of shop_slugs_slug_check (3.5). NOT VALID then
-- VALIDATE, as the other statements on an existing table; the reserved words stay in Market
-- configuration and never in a CHECK.
ALTER TABLE "sellers"."seller_files"
  ADD CONSTRAINT "seller_files_draft_slug_check" CHECK (
    "draft_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("draft_slug") BETWEEN 3 AND 50) NOT VALID;
ALTER TABLE "sellers"."seller_files" VALIDATE CONSTRAINT "seller_files_draft_slug_check";
