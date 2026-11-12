-- Multi-culture package 3a, ADR-0048 security review M2: `culture_categories.visible` may be NULL
-- (inherit), so a row made only to set a certification mark no longer states "shown". The
-- resolution hides a category when any row up its chain says hidden. Existing rows keep their
-- value. Every row must still state something (visible or a mark).

-- Safety: a blocked statement fails instead of queueing, and no statement runs unbounded.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable: dropping NOT NULL is a catalog-only change (no scan, no rewrite).
ALTER TABLE "catalog"."culture_categories" ALTER COLUMN "visible" DROP NOT NULL;

-- Hand-written: a row states a visibility or a mark. NOT VALID, then validated on its own.
ALTER TABLE "catalog"."culture_categories"
  ADD CONSTRAINT "culture_categories_states_something_check" CHECK (
    "visible" IS NOT NULL OR "certification_mark" IS NOT NULL) NOT VALID;

ALTER TABLE "catalog"."culture_categories" VALIDATE CONSTRAINT "culture_categories_states_something_check";
