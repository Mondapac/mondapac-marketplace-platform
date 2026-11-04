SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "catalog"."attribute_family_revisions" ADD COLUMN     "names" JSONB NOT NULL DEFAULT '{}';

-- Hand-written (database-designer): attributes package A4. The feature set's name per locale lives
-- in its insert-only revision, like the groups (the existing no-update trigger covers the new
-- column). The group names, the requirement level of each attribute and the Core group live
-- inside the `groups` document, which is read whole and never queried inside.
ALTER TABLE "catalog"."attribute_family_revisions"
  ADD CONSTRAINT "attribute_family_revisions_names_check" CHECK (jsonb_typeof("names") = 'object');
