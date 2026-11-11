-- Cultures (multi-culture package 1; ADR-0047). Creates catalog.cultures, catalog.culture_names and
-- catalog.culture_categories. Nothing is backfilled here: the first culture of each Market is
-- written by the catalog seed job. Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."cultures" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "required_certification_type" TEXT,
    "badge_colour" TEXT,
    "is_default" BOOLEAN NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "cultures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."culture_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "culture_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "culture_names_pkey" PRIMARY KEY ("market_id","culture_id","locale")
);

-- CreateTable
CREATE TABLE "catalog"."culture_categories" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "culture_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "visible" BOOLEAN NOT NULL,
    "certification_mark" TEXT,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "culture_categories_pkey" PRIMARY KEY ("market_id","culture_id","category_id")
);

-- CreateIndex
CREATE INDEX "cultures_market_id_status_display_order_idx" ON "catalog"."cultures"("market_id", "status", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "cultures_market_id_id_key" ON "catalog"."cultures"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cultures_market_id_code_key" ON "catalog"."cultures"("market_id", "code");

-- CreateIndex
CREATE INDEX "culture_categories_market_id_category_id_idx" ON "catalog"."culture_categories"("market_id", "category_id");

-- AddForeignKey
ALTER TABLE "catalog"."culture_names" ADD CONSTRAINT "culture_names_market_id_culture_id_fkey" FOREIGN KEY ("market_id", "culture_id") REFERENCES "catalog"."cultures"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."culture_categories" ADD CONSTRAINT "culture_categories_market_id_culture_id_fkey" FOREIGN KEY ("market_id", "culture_id") REFERENCES "catalog"."cultures"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."culture_categories" ADD CONSTRAINT "culture_categories_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. The code is the stable key (never updated). The English name and description
-- are required by the application, which knows the Market's locales; a locale is published only when
-- its description exists. The default culture is always active.
ALTER TABLE "catalog"."cultures"
  ADD CONSTRAINT "cultures_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cultures_code_check" CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 40),
  ADD CONSTRAINT "cultures_status_check" CHECK ("status" IN ('draft', 'active', 'inactive')),
  ADD CONSTRAINT "cultures_display_order_check" CHECK ("display_order" BETWEEN 0 AND 9999),
  ADD CONSTRAINT "cultures_required_certification_type_check" CHECK (
    "required_certification_type" IS NULL OR "required_certification_type" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cultures_badge_colour_check" CHECK (
    "badge_colour" IS NULL OR "badge_colour" ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD CONSTRAINT "cultures_default_active_check" CHECK (NOT "is_default" OR "status" = 'active'),
  ADD CONSTRAINT "cultures_version_check" CHECK ("version" >= 1);
ALTER TABLE "catalog"."culture_names"
  ADD CONSTRAINT "culture_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "culture_names_locale_check" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  ADD CONSTRAINT "culture_names_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "culture_names_description_check" CHECK (
    "description" IS NULL OR ("description" = btrim("description") AND length("description") BETWEEN 1 AND 300));
ALTER TABLE "catalog"."culture_categories"
  ADD CONSTRAINT "culture_categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "culture_categories_mark_check" CHECK (
    "certification_mark" IS NULL OR "certification_mark" IN ('required', 'neutral'));

-- A name is unique per Market and locale (case-insensitive): two cultures never share a label.
CREATE UNIQUE INDEX "culture_names_name_lower_key"
  ON "catalog"."culture_names" ("market_id", "locale", lower("name"));

-- At most one default culture per Market.
CREATE UNIQUE INDEX "cultures_one_default_key"
  ON "catalog"."cultures" ("market_id") WHERE "is_default";

-- Grants (database-designer). A culture row changes in everything except its code, creator and
-- creation time. Names are replaced as a set; a mark row is upserted or deleted. No culture is ever
-- deleted by the application (no DELETE on cultures): it is made inactive.
GRANT SELECT, INSERT,
  UPDATE ("status", "display_order", "required_certification_type", "badge_colour", "is_default", "updated_at", "version")
  ON TABLE "catalog"."cultures" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("name", "description") ON TABLE "catalog"."culture_names" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("visible", "certification_mark", "updated_by", "updated_at")
  ON TABLE "catalog"."culture_categories" TO "mondapac_app";
