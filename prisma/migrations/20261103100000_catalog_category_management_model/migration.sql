-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Categories package C2 (docs/design/data/catalog.md 3.4, 3.9; plan
-- design/categories/categories-management-plan-fa.html v7). Hand-written (database-designer).
-- Nothing is deployed and the category tables hold the seed rows only, so the small backfills
-- below run in this file (8.2 forbids that for large tables, not for these).

-- 1. platform_categories: position, hidden, menu flag, image, SEO.
ALTER TABLE "catalog"."platform_categories"
  ADD COLUMN "position" INTEGER,
  ADD COLUMN "show_in_menu" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "image_id" UUID,
  ADD COLUMN "seo_title" TEXT,
  ADD COLUMN "seo_description" TEXT,
  ADD COLUMN "seo_noindex" BOOLEAN NOT NULL DEFAULT false;

-- Siblings sort by name today: keep that order (the name of the published revision in the first
-- locale by code; the seed has one). Ties fall to the slug, which is unique.
WITH ranked AS (
  SELECT c."market_id", c."id",
         row_number() OVER (
           PARTITION BY c."market_id", c."parent_id"
           ORDER BY lower(n."name"), c."slug") - 1 AS pos
    FROM "catalog"."platform_categories" c
    LEFT JOIN LATERAL (
      SELECT x."name" FROM "catalog"."platform_category_revision_names" x
       WHERE x."market_id" = c."market_id" AND x."revision_id" = c."published_revision_id"
       ORDER BY x."locale" LIMIT 1) n ON true)
UPDATE "catalog"."platform_categories" c SET "position" = ranked.pos
  FROM ranked WHERE c."market_id" = ranked."market_id" AND c."id" = ranked."id";
ALTER TABLE "catalog"."platform_categories" ALTER COLUMN "position" SET NOT NULL;

ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "platform_categories_seo_title_check" CHECK (
    "seo_title" IS NULL OR (char_length("seo_title") BETWEEN 1 AND 60 AND "seo_title" = btrim("seo_title")
      AND "seo_title" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]')),
  ADD CONSTRAINT "platform_categories_seo_description_check" CHECK (
    "seo_description" IS NULL OR (char_length("seo_description") BETWEEN 1 AND 160
      AND "seo_description" = btrim("seo_description")
      AND "seo_description" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'));

-- Hidden joins the status list (reversible; merged and archived keep their meaning).
ALTER TABLE "catalog"."platform_categories" DROP CONSTRAINT "platform_categories_status_check";
ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_status_check" CHECK (
    "status" IN ('active', 'hidden', 'merged', 'archived')) NOT VALID;
ALTER TABLE "catalog"."platform_categories" VALIDATE CONSTRAINT "platform_categories_status_check";

-- One position per sibling in a Market. NULLS NOT DISTINCT makes the roots (parent NULL) siblings
-- too; DEFERRABLE lets a reorder swap positions inside one unit (the check runs at commit).
ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_market_id_parent_id_position_key"
  UNIQUE NULLS NOT DISTINCT ("market_id", "parent_id", "position") DEFERRABLE INITIALLY IMMEDIATE;

-- A row inserted without a position, or with -1, goes last among its siblings (the seed, which
-- passes -1 because Prisma requires a value, and raw inserts; the editor passes its own). The
-- sibling set is locked for the transaction, so two concurrent inserts take consecutive positions
-- instead of clashing. BEFORE INSERT runs before the CHECK and NOT NULL, so both still hold.
CREATE FUNCTION "catalog"."platform_categories_default_position"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'catalog.platform_categories.position/' || NEW."market_id" || '/' || coalesce(NEW."parent_id"::text, ''), 0));
  SELECT coalesce(max(c."position"), -1) + 1 INTO NEW."position"
    FROM "catalog"."platform_categories" c
   WHERE c."market_id" = NEW."market_id" AND c."parent_id" IS NOT DISTINCT FROM NEW."parent_id";
  RETURN NEW;
END; $$;
CREATE TRIGGER "platform_categories_default_position" BEFORE INSERT
  ON "catalog"."platform_categories" FOR EACH ROW WHEN (NEW."position" IS NULL OR NEW."position" = -1)
  EXECUTE FUNCTION "catalog"."platform_categories_default_position"();

-- 2. Revisions: more change kinds and a reason.
ALTER TABLE "catalog"."platform_category_revisions" ADD COLUMN "reason" TEXT;
ALTER TABLE "catalog"."platform_category_revisions"
  DROP CONSTRAINT "platform_category_revisions_change_kind_check";
ALTER TABLE "catalog"."platform_category_revisions"
  ADD CONSTRAINT "platform_category_revisions_change_kind_check" CHECK ("change_kind" IN (
    'created', 'renamed', 'moved', 'merged', 'archived',
    'details-changed', 'reordered', 'hidden', 'shown', 'slug-changed', 'discarded')) NOT VALID,
  -- Required for moved, merged and archived by the use case, not here (a seed row has none).
  ADD CONSTRAINT "platform_category_revisions_reason_check" CHECK (
    "reason" IS NULL OR (char_length("reason") BETWEEN 10 AND 500 AND "reason" = btrim("reason")
      AND "reason" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'));
ALTER TABLE "catalog"."platform_category_revisions"
  VALIDATE CONSTRAINT "platform_category_revisions_change_kind_check";

-- 3. Per-locale content: name, short description, search keywords (insert-only).
CREATE TABLE "catalog"."platform_category_revision_texts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_description" TEXT,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "platform_category_revision_texts_pkey" PRIMARY KEY ("market_id","revision_id","locale")
);
ALTER TABLE "catalog"."platform_category_revision_texts"
  ADD CONSTRAINT "platform_category_revision_texts_market_id_revision_id_fkey"
  FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."platform_category_revisions"("market_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "catalog"."platform_category_revision_texts"
  ADD CONSTRAINT "platform_category_revision_texts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_category_revision_texts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_category_revision_texts_locale_check" CHECK (
    "locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
  ADD CONSTRAINT "platform_category_revision_texts_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "platform_category_revision_texts_short_description_check" CHECK (
    "short_description" IS NULL OR (char_length("short_description") BETWEEN 1 AND 300
      AND "short_description" = btrim("short_description")
      AND "short_description" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]')),
  ADD CONSTRAINT "platform_category_revision_texts_keywords_check" CHECK (
    -- At most 20 keywords, none NULL, each 1 to 40 characters, trimmed, without control or bidi
    -- characters. No function (PUBLIC would execute it): the keywords are joined with U+0001, which
    -- no keyword may hold (the separators are counted), and the whole string must be a run of well-formed keywords.
    cardinality("keywords") <= 20 AND array_position("keywords", NULL) IS NULL
    AND (cardinality("keywords") = 0
         OR (char_length(array_to_string("keywords", E'\x01'))
               - char_length(replace(array_to_string("keywords", E'\x01'), E'\x01', '')) = cardinality("keywords") - 1
             AND array_to_string("keywords", E'\x01') ~ '^[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩\s](?:[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]{0,38}[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩\s])?(\u0001[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩\s](?:[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]{0,38}[^\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩\s])?)*$')));

-- No name is lost: every existing name moves over. platform_category_revision_names stays as it
-- is (readable, insert-only); until the editor (C3) writes the texts itself, a trigger copies each
-- new name row (the text row of a revision is written first by C3; a name that differs from an
-- existing text is not copied).
INSERT INTO "catalog"."platform_category_revision_texts" ("market_id", "tenant_id", "revision_id", "locale", "name")
  SELECT "market_id", "tenant_id", "revision_id", "locale", "name"
    FROM "catalog"."platform_category_revision_names";

CREATE FUNCTION "catalog"."platform_category_names_copy_to_texts"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "catalog"."platform_category_revision_texts"
      ("market_id", "tenant_id", "revision_id", "locale", "name")
    VALUES (NEW."market_id", NEW."tenant_id", NEW."revision_id", NEW."locale", NEW."name")
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER "platform_category_revision_names_copy_to_texts" AFTER INSERT
  ON "catalog"."platform_category_revision_names" FOR EACH ROW
  EXECUTE FUNCTION "catalog"."platform_category_names_copy_to_texts"();

-- 4. Slug history: a retired slug redirects to its category and is not given to another category
-- for 12 months. Insert-only. A slug can be retired again after a later reuse, so retired_at is
-- part of the key; a lookup takes the latest row.
CREATE TABLE "catalog"."platform_category_slug_history" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT COLLATE "C" NOT NULL,
    "category_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_category_slug_history_pkey" PRIMARY KEY ("market_id","slug","retired_at")
);
CREATE INDEX "platform_category_slug_history_market_id_category_id_idx"
  ON "catalog"."platform_category_slug_history"("market_id", "category_id");
ALTER TABLE "catalog"."platform_category_slug_history"
  ADD CONSTRAINT "platform_category_slug_history_market_id_category_id_fkey"
  FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "catalog"."platform_category_slug_history"
  ADD CONSTRAINT "platform_category_slug_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_category_slug_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_category_slug_history_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 80);

-- Backstop for the 12 months: a category cannot be created with, or (once the slug is editable)
-- changed to, a slug another category retired less than a year ago. The use case checks first;
-- this refuses what it missed. A category's own old slug may return.
CREATE FUNCTION "catalog"."platform_categories_slug_not_recently_retired"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "catalog"."platform_category_slug_history" h
              WHERE h."market_id" = NEW."market_id" AND h."slug" = NEW."slug"
                AND h."category_id" <> NEW."id"
                AND h."retired_at" > pg_catalog.now() - interval '12 months') THEN
    RAISE EXCEPTION 'catalog.platform_categories: slug retired less than 12 months ago'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "platform_categories_slug_not_recently_retired" BEFORE INSERT OR UPDATE OF "slug"
  ON "catalog"."platform_categories" FOR EACH ROW
  EXECUTE FUNCTION "catalog"."platform_categories_slug_not_recently_retired"();

-- 5. Product side: one primary category per revision.
ALTER TABLE "catalog"."product_revision_categories"
  ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;
-- The table is insert-only for every role; the one-time backfill switches the guard off and on
-- again inside this transaction. First category (lowest position) is primary.
ALTER TABLE "catalog"."product_revision_categories"
  DISABLE TRIGGER "product_revision_categories_no_update_delete";
UPDATE "catalog"."product_revision_categories" p SET "is_primary" = true
  FROM (SELECT DISTINCT ON ("market_id", "revision_id") "market_id", "revision_id", "category_id"
          FROM "catalog"."product_revision_categories"
         ORDER BY "market_id", "revision_id", "position", "category_id") first
 WHERE p."market_id" = first."market_id" AND p."revision_id" = first."revision_id"
   AND p."category_id" = first."category_id";
ALTER TABLE "catalog"."product_revision_categories"
  ENABLE TRIGGER "product_revision_categories_no_update_delete";
-- Partial unique: Prisma cannot express it (listed in docs 8.4).
CREATE UNIQUE INDEX "product_revision_categories_market_id_revision_id_primary_key"
  ON "catalog"."product_revision_categories"("market_id", "revision_id") WHERE "is_primary";

-- 6. Insert-only triggers of the new tables (CA3, data design 5.1), row and statement level.
CREATE TRIGGER "platform_category_revision_texts_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."platform_category_revision_texts"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_revision_texts_no_truncate" BEFORE TRUNCATE
  ON "catalog"."platform_category_revision_texts"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_slug_history_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."platform_category_slug_history"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "platform_category_slug_history_no_truncate" BEFORE TRUNCATE
  ON "catalog"."platform_category_slug_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (database-designer): docs/design/data/catalog.md section 7. The editor's columns only.
-- The slug stays outside the list: the application still cannot change it. The package that
-- builds Change URL name (with its history row) grants it, so the privilege and its writer arrive
-- together. The creator kind, the market and the id never change. Nothing is deleted.
GRANT UPDATE ("position", "show_in_menu", "image_id", "seo_title", "seo_description", "seo_noindex")
  ON TABLE "catalog"."platform_categories" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."platform_category_revision_texts" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."platform_category_slug_history" TO "mondapac_app";
