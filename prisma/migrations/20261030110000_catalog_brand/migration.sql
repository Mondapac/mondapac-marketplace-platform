-- Brand entity (catalog brand package, PR 1). Creates catalog.brands, catalog.brand_aliases and the
-- merge queue catalog.brand_merge_candidates, adds products.brand_id, and backfills brands from the
-- `brand` attribute of each product's published revision.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- The backfill reads every published revision once; bound how long that may take.
SET statement_timeout = '300s';

-- AlterTable
ALTER TABLE "catalog"."products" ADD COLUMN     "brand_id" UUID;

-- CreateTable
CREATE TABLE "catalog"."brands" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "logo_image_id" UUID,
    "logo_alt" TEXT,
    "header_image_id" UUID,
    "summary" TEXT,
    "origin_country" CHAR(2),
    "status" TEXT NOT NULL,
    "proposed_by_seller_id" UUID,
    "approved_by" UUID,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."brand_aliases" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "brand_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."brand_merge_candidates" (
    "id" UUID NOT NULL,
    "group_key" TEXT NOT NULL,
    "brand_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "resolution" TEXT,
    "detected_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,

    CONSTRAINT "brand_merge_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_slug_key" ON "catalog"."brands"("slug");

-- CreateIndex
CREATE INDEX "brands_status_name_idx" ON "catalog"."brands"("status", "name");

-- CreateIndex
CREATE INDEX "brands_name_key_idx" ON "catalog"."brands"("name_key");

-- CreateIndex
CREATE INDEX "brand_aliases_brand_id_idx" ON "catalog"."brand_aliases"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_merge_candidates_brand_id_key" ON "catalog"."brand_merge_candidates"("brand_id");

-- CreateIndex
CREATE INDEX "brand_merge_candidates_status_group_key_idx" ON "catalog"."brand_merge_candidates"("status", "group_key");

-- CreateIndex
CREATE INDEX "products_market_id_brand_id_idx" ON "catalog"."products"("market_id", "brand_id");

-- AddForeignKey
ALTER TABLE "catalog"."brands" ADD CONSTRAINT "brands_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "catalog"."brands"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."brand_aliases" ADD CONSTRAINT "brand_aliases_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "catalog"."brands"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."brand_merge_candidates" ADD CONSTRAINT "brand_merge_candidates_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "catalog"."brands"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. A brand name is stored trimmed; the slug is the URL of the public page.
ALTER TABLE "catalog"."brands"
  ADD CONSTRAINT "brands_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 80),
  ADD CONSTRAINT "brands_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 120),
  ADD CONSTRAINT "brands_name_key_check" CHECK ("name_key" <> ''),
  ADD CONSTRAINT "brands_status_check" CHECK ("status" IN ('draft', 'active', 'archived')),
  ADD CONSTRAINT "brands_origin_country_check" CHECK ("origin_country" IS NULL OR "origin_country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "brands_summary_check" CHECK ("summary" IS NULL OR length("summary") BETWEEN 1 AND 1000),
  -- A logo always has its alt text, and alt text never stands without a logo.
  ADD CONSTRAINT "brands_logo_alt_check" CHECK (
    ("logo_image_id" IS NULL AND "logo_alt" IS NULL)
    OR ("logo_image_id" IS NOT NULL AND "logo_alt" IS NOT NULL AND length("logo_alt") BETWEEN 1 AND 200)),
  -- Only a merge archives a brand into another one.
  ADD CONSTRAINT "brands_merged_into_check" CHECK (
    "merged_into_id" IS NULL OR ("status" = 'archived' AND "merged_into_id" <> "id")),
  -- A draft is a proposal that no admin has approved.
  ADD CONSTRAINT "brands_draft_check" CHECK ("status" <> 'draft' OR "approved_by" IS NULL),
  ADD CONSTRAINT "brands_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."brand_aliases"
  ADD CONSTRAINT "brand_aliases_alias_check" CHECK ("alias" = btrim("alias") AND length("alias") BETWEEN 1 AND 120);

-- Hand-written: one alias spelling exists once, whatever its case, across all brands.
CREATE UNIQUE INDEX "brand_aliases_alias_lower_key" ON "catalog"."brand_aliases" (lower("alias"));

ALTER TABLE "catalog"."brand_merge_candidates"
  ADD CONSTRAINT "brand_merge_candidates_group_key_check" CHECK ("group_key" <> ''),
  ADD CONSTRAINT "brand_merge_candidates_status_check" CHECK ("status" IN ('open', 'resolved')),
  ADD CONSTRAINT "brand_merge_candidates_resolution_check" CHECK (
    "resolution" IS NULL OR "resolution" IN ('merged', 'kept-separate')),
  -- An open row has no outcome; a resolved row has all of it.
  ADD CONSTRAINT "brand_merge_candidates_state_check" CHECK (
    ("status" = 'open' AND "resolution" IS NULL AND "resolved_at" IS NULL AND "resolved_by" IS NULL)
    OR ("status" = 'resolved' AND "resolution" IS NOT NULL AND "resolved_at" IS NOT NULL));

-- Backfill, step 1: helper functions. They live in pg_temp and vanish with this session.
-- brand_name_key: the near-duplicate key of a name. Trim, lowercase, read "&" as "and", then keep
-- letters and digits only, so "Fuji & Co.", "FUJI AND CO" and "fuji-and-co" share one key. The
-- application computes the same key (catalog/domain/brand.ts, brandNameKey).
CREATE FUNCTION pg_temp.brand_name_key(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(replace(lower(btrim(name)), '&', ' and '), '[^[:alnum:]]+', '', 'g')
$$;

-- brand_slug: lowercase ASCII words joined by hyphens, at most 70 characters (room for a numeric
-- suffix); "brand" when the name has no ASCII letter or digit.
CREATE FUNCTION pg_temp.brand_slug(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    nullif(btrim(left(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), 70), '-'), ''),
    'brand')
$$;

-- uuid_v7: the ids of this application are UUIDv7. gen_random_uuid() is a v4 whose version nibble
-- 0100 becomes 0111 by setting two bits, after the first 48 bits are replaced by the millisecond clock.
CREATE FUNCTION pg_temp.uuid_v7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- Backfill, step 2: the brand values. The `brand` attribute of each product's PUBLISHED revision, as
-- text, trimmed. A value with no letter or digit, or longer than a brand name may be, names no brand.
CREATE TEMPORARY TABLE "brand_values" AS
  SELECT DISTINCT btrim(r."attribute_values" ->> 'brand') AS "name"
    FROM "catalog"."products" p
    JOIN "catalog"."product_revisions" r
      ON r."market_id" = p."market_id" AND r."product_id" = p."id" AND r."id" = p."published_revision_id"
   WHERE jsonb_typeof(r."attribute_values" -> 'brand') = 'string'
     AND length(btrim(r."attribute_values" ->> 'brand')) BETWEEN 1 AND 120
     AND pg_temp.brand_name_key(r."attribute_values" ->> 'brand') <> '';

-- Backfill, step 3: one ACTIVE brand per distinct trimmed value, in byte order of the value so a
-- re-run on the same data gives the same slugs. A slug taken by an earlier brand gets "-2", "-3", ...
DO $backfill$
DECLARE
  value record;
  base text;
  candidate text;
  suffix integer;
BEGIN
  FOR value IN SELECT "name" FROM "brand_values" ORDER BY "name" COLLATE "C" LOOP
    base := pg_temp.brand_slug(value."name");
    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM "catalog"."brands" WHERE "slug" = candidate) LOOP
      suffix := suffix + 1;
      candidate := base || '-' || suffix;
    END LOOP;
    INSERT INTO "catalog"."brands" ("id", "slug", "name", "name_key", "status", "created_at", "updated_at", "version")
    VALUES (pg_temp.uuid_v7(), candidate, value."name", pg_temp.brand_name_key(value."name"),
            'active', now(), now(), 1);
  END LOOP;
END
$backfill$;

-- Backfill, step 4: point each product at the brand of its published value. Names are unique here
-- (the table was empty and the values are distinct), so each product matches exactly one brand.
UPDATE "catalog"."products" p
   SET "brand_id" = b."id"
  FROM "catalog"."product_revisions" r, "catalog"."brands" b
 WHERE r."market_id" = p."market_id" AND r."product_id" = p."id" AND r."id" = p."published_revision_id"
   AND jsonb_typeof(r."attribute_values" -> 'brand') = 'string'
   AND b."name" = btrim(r."attribute_values" ->> 'brand');

DROP TABLE "brand_values";

-- Backfill, step 5: near-duplicates are NOT merged. Every brand whose name key is shared goes to the
-- merge queue, one open row per brand, for an admin to merge or keep apart.
INSERT INTO "catalog"."brand_merge_candidates" ("id", "group_key", "brand_id", "status", "detected_at")
SELECT pg_temp.uuid_v7(), b."name_key", b."id", 'open', now()
  FROM "catalog"."brands" b
 WHERE b."name_key" IN (
   SELECT "name_key" FROM "catalog"."brands" GROUP BY "name_key" HAVING count(*) > 1);

-- Hand-written: the integrity of products.brand_id. A foreign key would be the usual tool, but
-- Prisma could not describe it: brands are exempt from the market scope, products are scoped, and
-- the schema checks (scripts/check-prisma-boundaries.mjs) forbid a relation between the two, so
-- `prisma migrate diff` would want to drop the constraint. These two triggers keep the same promise:
-- a product names an existing brand, and a brand that exists is never deleted (it is archived).
-- Created after the backfill, which wrote consistent rows.
CREATE FUNCTION "catalog"."products_brand_exists"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."brand_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "catalog"."brands" WHERE "id" = NEW."brand_id") THEN
    RAISE EXCEPTION 'catalog.products: brand_id names no brand'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "products_brand_exists" BEFORE INSERT OR UPDATE OF "brand_id"
  ON "catalog"."products"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."products_brand_exists"();
CREATE TRIGGER "brands_no_delete" BEFORE DELETE ON "catalog"."brands"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "brands_no_truncate" BEFORE TRUNCATE ON "catalog"."brands"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (database-designer). A brand is never deleted. Identity, origin and creation columns never
-- change; an alias row only moves to another brand (a merge); a queue row only gets its outcome.
GRANT SELECT, INSERT, UPDATE ("slug", "name", "name_key", "logo_image_id", "logo_alt", "header_image_id",
  "summary", "origin_country", "status", "approved_by", "merged_into_id", "updated_at", "version")
  ON TABLE "catalog"."brands" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("brand_id") ON TABLE "catalog"."brand_aliases" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "resolution", "resolved_at", "resolved_by")
  ON TABLE "catalog"."brand_merge_candidates" TO "mondapac_app";
GRANT UPDATE ("brand_id") ON TABLE "catalog"."products" TO "mondapac_app";
