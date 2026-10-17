-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "storefront";

-- CreateTable
CREATE TABLE "storefront"."pages" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "system_key" TEXT,
    "slug" TEXT,
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "seo" JSONB NOT NULL,
    "linked_type" TEXT,
    "linked_id" UUID,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "archived_redirect" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront"."page_versions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "page_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "placements" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront"."redirects" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_slug" TEXT NOT NULL,
    "page_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pages_market_id_kind_created_at_id_idx" ON "storefront"."pages"("market_id", "kind", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pages_market_id_id_key" ON "storefront"."pages"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pages_market_id_system_key_key" ON "storefront"."pages"("market_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "pages_market_id_slug_key" ON "storefront"."pages"("market_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_market_id_page_id_version_no_key" ON "storefront"."page_versions"("market_id", "page_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "redirects_market_id_from_slug_key" ON "storefront"."redirects"("market_id", "from_slug");

-- AddForeignKey
ALTER TABLE "storefront"."page_versions" ADD CONSTRAINT "page_versions_market_id_page_id_fkey" FOREIGN KEY ("market_id", "page_id") REFERENCES "storefront"."pages"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storefront"."redirects" ADD CONSTRAINT "redirects_market_id_page_id_fkey" FOREIGN KEY ("market_id", "page_id") REFERENCES "storefront"."pages"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: at most one draft and one published version per page.
CREATE UNIQUE INDEX "page_versions_one_draft_key" ON "storefront"."page_versions" ("market_id", "page_id") WHERE "state" = 'draft';
CREATE UNIQUE INDEX "page_versions_one_published_key" ON "storefront"."page_versions" ("market_id", "page_id") WHERE "state" = 'published';

-- Hand-written: scope and value checks. Templates, slots, modules and the shape of `seo` and
-- `placements` are checked by the application; the database keeps the closed kinds and states,
-- the key formats and the system/dynamic split.
ALTER TABLE "storefront"."pages"
  ADD CONSTRAINT "pages_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "pages_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "pages_kind_check" CHECK (
    ("kind" = 'system' AND "system_key" IS NOT NULL AND "slug" IS NULL)
    OR ("kind" = 'dynamic' AND "system_key" IS NULL AND "slug" IS NOT NULL)),
  ADD CONSTRAINT "pages_system_key_check" CHECK ("system_key" ~ '^[a-z][a-z0-9-]{0,39}$'),
  ADD CONSTRAINT "pages_slug_check" CHECK (
    char_length("slug") <= 80 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "pages_template_key_check" CHECK ("template_key" ~ '^[a-z][a-z0-9.-]{0,63}$'),
  ADD CONSTRAINT "pages_title_check" CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "pages_seo_check" CHECK (jsonb_typeof("seo") = 'object'),
  ADD CONSTRAINT "pages_linked_check" CHECK (
    ("linked_type" IS NULL AND "linked_id" IS NULL)
    OR ("linked_type" IN ('category', 'product', 'seller') AND "linked_id" IS NOT NULL)),
  ADD CONSTRAINT "pages_window_check" CHECK (
    "starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at"),
  ADD CONSTRAINT "pages_archived_check" CHECK (
    ("archived_at" IS NULL AND "archived_redirect" IS NULL) OR "kind" = 'dynamic'),
  ADD CONSTRAINT "pages_archived_redirect_check" CHECK (
    "archived_redirect" IS NULL OR (char_length("archived_redirect") <= 200
      AND "archived_redirect" ~ '^/[A-Za-z0-9/_.~-]*$' AND "archived_redirect" !~ '^//'));

ALTER TABLE "storefront"."page_versions"
  ADD CONSTRAINT "page_versions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "page_versions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "page_versions_version_no_check" CHECK ("version_no" >= 1),
  ADD CONSTRAINT "page_versions_state_check" CHECK ("state" IN ('draft', 'published', 'retired')),
  ADD CONSTRAINT "page_versions_placements_check" CHECK (jsonb_typeof("placements") = 'object'),
  ADD CONSTRAINT "page_versions_published_check" CHECK (
    ("state" = 'draft' AND "published_at" IS NULL AND "published_by" IS NULL)
    OR ("state" <> 'draft' AND "published_at" IS NOT NULL AND "published_by" IS NOT NULL));

ALTER TABLE "storefront"."redirects"
  ADD CONSTRAINT "redirects_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "redirects_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "redirects_from_slug_check" CHECK (
    char_length("from_slug") <= 80 AND "from_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Grants. A page is created and changed, never deleted (archived instead); its kind, key and
-- template never change. A version is created and its content and state change; none is deleted.
-- A redirect is created, and removed when its page takes the old slug back.
GRANT USAGE ON SCHEMA "storefront" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("slug", "title", "seo", "linked_type", "linked_id", "starts_at", "ends_at", "archived_at", "archived_redirect", "updated_at", "updated_by") ON TABLE "storefront"."pages" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "placements", "updated_at", "updated_by", "published_at", "published_by") ON TABLE "storefront"."page_versions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "storefront"."redirects" TO "mondapac_app";
