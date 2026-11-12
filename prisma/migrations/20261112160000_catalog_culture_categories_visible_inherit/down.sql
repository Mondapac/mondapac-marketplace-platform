-- Reverses 20261112160000_catalog_culture_categories_visible_inherit. A row that inherits its
-- visibility becomes "shown", which is what a mark-only row stated before the change.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."culture_categories" DROP CONSTRAINT "culture_categories_states_something_check";
UPDATE "catalog"."culture_categories" SET "visible" = true WHERE "visible" IS NULL;
ALTER TABLE "catalog"."culture_categories" ALTER COLUMN "visible" SET NOT NULL;
