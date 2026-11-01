-- Business activities (catalog business-activity package, PR 1). Creates catalog.business_activities,
-- catalog.business_activity_names and catalog.business_activity_categories. Nothing is backfilled:
-- an admin defines the activities. Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."business_activities" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "business_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."business_activity_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "activity_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "business_activity_names_pkey" PRIMARY KEY ("market_id","activity_id","locale")
);

-- CreateTable
CREATE TABLE "catalog"."business_activity_categories" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "activity_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_activity_categories_pkey" PRIMARY KEY ("market_id","activity_id","category_id")
);

-- CreateIndex
CREATE INDEX "business_activities_market_id_status_idx" ON "catalog"."business_activities"("market_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "business_activities_market_id_id_key" ON "catalog"."business_activities"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_activities_market_id_code_key" ON "catalog"."business_activities"("market_id", "code");

-- CreateIndex
CREATE INDEX "business_activity_categories_market_id_category_id_idx" ON "catalog"."business_activity_categories"("market_id", "category_id");

-- AddForeignKey
ALTER TABLE "catalog"."business_activity_names" ADD CONSTRAINT "business_activity_names_market_id_activity_id_fkey" FOREIGN KEY ("market_id", "activity_id") REFERENCES "catalog"."business_activities"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."business_activity_categories" ADD CONSTRAINT "business_activity_categories_market_id_activity_id_fkey" FOREIGN KEY ("market_id", "activity_id") REFERENCES "catalog"."business_activities"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."business_activity_categories" ADD CONSTRAINT "business_activity_categories_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. The code is the stable key (never updated); the English name is required by
-- the application, which knows the Market's locales.
ALTER TABLE "catalog"."business_activities"
  ADD CONSTRAINT "business_activities_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "business_activities_code_check" CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 40),
  ADD CONSTRAINT "business_activities_description_check" CHECK (
    "description" IS NULL OR ("description" = btrim("description") AND length("description") BETWEEN 1 AND 300)),
  ADD CONSTRAINT "business_activities_status_check" CHECK ("status" IN ('active', 'inactive')),
  ADD CONSTRAINT "business_activities_version_check" CHECK ("version" >= 1);
ALTER TABLE "catalog"."business_activity_names"
  ADD CONSTRAINT "business_activity_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "business_activity_names_locale_check" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  ADD CONSTRAINT "business_activity_names_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 80);
ALTER TABLE "catalog"."business_activity_categories"
  ADD CONSTRAINT "business_activity_categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- A name is unique per Market and locale (case-insensitive): two activities never share a label.
CREATE UNIQUE INDEX "business_activity_names_name_lower_key"
  ON "catalog"."business_activity_names" ("market_id", "locale", lower("name"));

-- Grants (database-designer). An activity row changes in its description, status and version; the
-- code and creator never change. Names and links are replaced as a set, so they may be deleted.
GRANT SELECT, INSERT, DELETE, UPDATE ("description", "status", "updated_at", "version")
  ON TABLE "catalog"."business_activities" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("name") ON TABLE "catalog"."business_activity_names" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "catalog"."business_activity_categories" TO "mondapac_app";
