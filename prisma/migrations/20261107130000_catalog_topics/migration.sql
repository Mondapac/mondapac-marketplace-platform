-- Topics (product tags package T1). Creates catalog.topics and catalog.topic_terms: the admin's
-- curated list of shopping themes (Ramadan, Persian cuisine, BBQ) per Market. Nothing is
-- backfilled: an admin defines the topics. Products pick topics in a later package (T2).
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."topics" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "topic_group" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "intro" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."topic_terms" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "topic_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "term_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "topic_terms_pkey" PRIMARY KEY ("market_id","topic_id","locale","position")
);

-- CreateIndex
CREATE INDEX "topics_market_id_status_topic_group_idx" ON "catalog"."topics"("market_id", "status", "topic_group");

-- CreateIndex
CREATE UNIQUE INDEX "topics_market_id_id_key" ON "catalog"."topics"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "topics_market_id_slug_key" ON "catalog"."topics"("market_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "topic_terms_market_id_locale_term_key_key" ON "catalog"."topic_terms"("market_id", "locale", "term_key");

-- AddForeignKey
ALTER TABLE "catalog"."topic_terms" ADD CONSTRAINT "topic_terms_market_id_topic_id_fkey" FOREIGN KEY ("market_id", "topic_id") REFERENCES "catalog"."topics"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: CHECKs. The slug is the stable key (never updated). The application requires the
-- name in the Market's default locale and refuses claim words; the database holds the shapes.
ALTER TABLE "catalog"."topics"
  ADD CONSTRAINT "topics_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "topics_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 40),
  ADD CONSTRAINT "topics_topic_group_check" CHECK ("topic_group" IN ('occasion', 'cuisine', 'use')),
  ADD CONSTRAINT "topics_status_check" CHECK ("status" IN ('active', 'archived')),
  ADD CONSTRAINT "topics_intro_check" CHECK (
    "intro" IS NULL OR ("intro" = btrim("intro") AND length("intro") BETWEEN 1 AND 1000)),
  ADD CONSTRAINT "topics_version_check" CHECK ("version" >= 1);
-- Position 0 is the name and only the name: with the primary key, at most one name per topic and
-- locale. A synonym follows at 1 to 10.
ALTER TABLE "catalog"."topic_terms"
  ADD CONSTRAINT "topic_terms_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "topic_terms_locale_check" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  ADD CONSTRAINT "topic_terms_kind_check" CHECK ("kind" IN ('name', 'synonym')),
  ADD CONSTRAINT "topic_terms_position_check" CHECK (
    "position" BETWEEN 0 AND 10 AND ("kind" = 'name') = ("position" = 0)),
  ADD CONSTRAINT "topic_terms_term_check" CHECK ("term" = btrim("term") AND length("term") BETWEEN 2 AND 40),
  ADD CONSTRAINT "topic_terms_term_key_check" CHECK (
    "term_key" = btrim("term_key") AND length("term_key") BETWEEN 2 AND 160);

-- Grants (database-designer). A topic row changes in its group, status, intro and version; the
-- slug and creator never change, and a topic is never deleted (archived instead). Terms are
-- replaced as a set, so they may be deleted, never updated.
GRANT SELECT, INSERT, UPDATE ("topic_group", "status", "intro", "updated_at", "version")
  ON TABLE "catalog"."topics" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "catalog"."topic_terms" TO "mondapac_app";
