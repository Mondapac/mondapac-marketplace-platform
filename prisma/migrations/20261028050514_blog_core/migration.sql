-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "blog";

-- AlterTable
ALTER TABLE "sellers"."seller_admin_settings" ADD COLUMN     "blog_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blog_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "blog_enabled_by" UUID;

-- CreateTable
CREATE TABLE "blog"."posts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "seller_id" UUID,
    "status" TEXT NOT NULL,
    "live_version_id" UUID,
    "draft_version_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "unpublished_at" TIMESTAMPTZ(6),
    "paused_reason" TEXT,
    "featured" BOOLEAN NOT NULL,
    "quota_period" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog"."post_versions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "post_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "cover_image_id" UUID,
    "cover_alt" TEXT,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "author_display" TEXT,
    "category_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "edited_by_reviewer" BOOLEAN NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decision" TEXT,
    "decision_note" TEXT,
    "self_approved" BOOLEAN NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,

    CONSTRAINT "post_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog"."post_events" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "attendance" TEXT NOT NULL,
    "venue_name" TEXT,
    "address" TEXT,
    "registration_url" TEXT,
    "event_status" TEXT NOT NULL,
    "status_message" TEXT,

    CONSTRAINT "post_events_pkey" PRIMARY KEY ("market_id","version_id")
);

-- CreateTable
CREATE TABLE "blog"."post_links" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_ref" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "post_links_pkey" PRIMARY KEY ("market_id","version_id","position")
);

-- CreateTable
CREATE TABLE "blog"."categories" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog"."category_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "category_names_pkey" PRIMARY KEY ("market_id","category_id","locale")
);

-- CreateTable
CREATE TABLE "blog"."tags" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog"."post_tags" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "post_tags_pkey" PRIMARY KEY ("market_id","version_id","tag_id")
);

-- CreateTable
CREATE TABLE "blog"."redirects" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_slug" TEXT NOT NULL,
    "post_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog"."seller_quotas" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "used" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_quotas_pkey" PRIMARY KEY ("market_id","seller_id","period")
);

-- CreateTable
CREATE TABLE "blog"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "blog"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE INDEX "posts_market_id_status_created_at_id_idx" ON "blog"."posts"("market_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "posts_market_id_seller_id_created_at_id_idx" ON "blog"."posts"("market_id", "seller_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "posts_market_id_id_key" ON "blog"."posts"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_market_id_slug_key" ON "blog"."posts"("market_id", "slug");

-- CreateIndex
CREATE INDEX "post_versions_market_id_state_submitted_at_idx" ON "blog"."post_versions"("market_id", "state", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_versions_market_id_post_id_id_key" ON "blog"."post_versions"("market_id", "post_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "post_versions_market_id_post_id_version_no_key" ON "blog"."post_versions"("market_id", "post_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "post_versions_market_id_id_key" ON "blog"."post_versions"("market_id", "id");

-- CreateIndex
CREATE INDEX "post_events_market_id_starts_at_idx" ON "blog"."post_events"("market_id", "starts_at");

-- CreateIndex
CREATE INDEX "post_links_market_id_target_type_target_ref_idx" ON "blog"."post_links"("market_id", "target_type", "target_ref");

-- CreateIndex
CREATE UNIQUE INDEX "post_links_market_id_version_id_target_type_target_ref_key" ON "blog"."post_links"("market_id", "version_id", "target_type", "target_ref");

-- CreateIndex
CREATE UNIQUE INDEX "categories_market_id_id_key" ON "blog"."categories"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_market_id_slug_key" ON "blog"."categories"("market_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "tags_market_id_id_key" ON "blog"."tags"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_market_id_slug_key" ON "blog"."tags"("market_id", "slug");

-- CreateIndex
CREATE INDEX "post_tags_market_id_tag_id_idx" ON "blog"."post_tags"("market_id", "tag_id");

-- CreateIndex
CREATE INDEX "redirects_market_id_post_id_idx" ON "blog"."redirects"("market_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "redirects_market_id_from_slug_key" ON "blog"."redirects"("market_id", "from_slug");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "blog"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- AddForeignKey. The two version pointers of a post are deferred (hand-edited): a post and its first
-- version point at each other, so the pair is checked at commit.
ALTER TABLE "blog"."posts" ADD CONSTRAINT "posts_market_id_id_live_version_id_fkey" FOREIGN KEY ("market_id", "id", "live_version_id") REFERENCES "blog"."post_versions"("market_id", "post_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "blog"."posts" ADD CONSTRAINT "posts_market_id_id_draft_version_id_fkey" FOREIGN KEY ("market_id", "id", "draft_version_id") REFERENCES "blog"."post_versions"("market_id", "post_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "blog"."post_versions" ADD CONSTRAINT "post_versions_market_id_post_id_fkey" FOREIGN KEY ("market_id", "post_id") REFERENCES "blog"."posts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."post_versions" ADD CONSTRAINT "post_versions_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "blog"."categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."post_events" ADD CONSTRAINT "post_events_market_id_version_id_fkey" FOREIGN KEY ("market_id", "version_id") REFERENCES "blog"."post_versions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."post_links" ADD CONSTRAINT "post_links_market_id_version_id_fkey" FOREIGN KEY ("market_id", "version_id") REFERENCES "blog"."post_versions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."category_names" ADD CONSTRAINT "category_names_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "blog"."categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."post_tags" ADD CONSTRAINT "post_tags_market_id_version_id_fkey" FOREIGN KEY ("market_id", "version_id") REFERENCES "blog"."post_versions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."post_tags" ADD CONSTRAINT "post_tags_market_id_tag_id_fkey" FOREIGN KEY ("market_id", "tag_id") REFERENCES "blog"."tags"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blog"."redirects" ADD CONSTRAINT "redirects_market_id_post_id_fkey" FOREIGN KEY ("market_id", "post_id") REFERENCES "blog"."posts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: value checks. The block list of a body, the lifecycle rules, the checks of a post
-- and the quota maths are the application's; the database keeps the closed kinds, states, key
-- formats, the pairs of columns that go together, the size limits, and no markup or control
-- character in any text, as defence in depth.
ALTER TABLE "sellers"."seller_admin_settings"
  ADD CONSTRAINT "seller_admin_settings_blog_enabled_changed_check" CHECK (
    ("blog_enabled_at" IS NULL) = ("blog_enabled_by" IS NULL));

ALTER TABLE "blog"."categories"
  ADD CONSTRAINT "categories_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "categories_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 60),
  ADD CONSTRAINT "categories_position_check" CHECK ("position" BETWEEN 0 AND 10000);

ALTER TABLE "blog"."category_names"
  ADD CONSTRAINT "category_names_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_names_locale_check" CHECK ("locale" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  ADD CONSTRAINT "category_names_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60
    AND "name" !~ E'[\\u0001-\\u0008\\u000A-\\u001F\\u007F-\\u009F<>]');

ALTER TABLE "blog"."tags"
  ADD CONSTRAINT "tags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "tags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "tags_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 40),
  ADD CONSTRAINT "tags_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 40
    AND "name" !~ E'[\\u0001-\\u0008\\u000A-\\u001F\\u007F-\\u009F<>]');

ALTER TABLE "blog"."posts"
  ADD CONSTRAINT "posts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "posts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "posts_kind_check" CHECK ("kind" IN ('product', 'brand', 'event', 'news')),
  -- Lower-case words joined by hyphens; the words that are routes under /blog are reserved.
  ADD CONSTRAINT "posts_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 80
    AND "slug" NOT IN ('category', 'tag', 'events', 'rss', 'feed', 'search', 'page')),
  ADD CONSTRAINT "posts_owner_check" CHECK (
    ("owner_type" = 'platform' AND "seller_id" IS NULL)
    OR ("owner_type" = 'seller' AND "seller_id" IS NOT NULL)),
  ADD CONSTRAINT "posts_status_check" CHECK (
    "status" IN ('draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published',
      'unpublished', 'archived')),
  -- A post that was never live has a version being worked on and none live; a post that was live
  -- keeps its live version, also when it is unpublished.
  ADD CONSTRAINT "posts_pointers_check" CHECK (
    ("status" IN ('draft', 'in_review', 'changes_requested', 'approved', 'scheduled')
      AND "live_version_id" IS NULL AND "draft_version_id" IS NOT NULL)
    OR ("status" IN ('published', 'unpublished') AND "live_version_id" IS NOT NULL)
    OR "status" = 'archived'),
  ADD CONSTRAINT "posts_published_at_check" CHECK (("published_at" IS NULL) = ("live_version_id" IS NULL)),
  ADD CONSTRAINT "posts_schedule_check" CHECK (
    ("status" <> 'scheduled' OR "scheduled_at" IS NOT NULL)
    AND ("scheduled_at" IS NULL
      OR ("status" IN ('scheduled', 'published', 'unpublished') AND "draft_version_id" IS NOT NULL))),
  ADD CONSTRAINT "posts_unpublished_check" CHECK (
    ("status" <> 'unpublished' OR ("unpublished_at" IS NOT NULL AND "paused_reason" IS NOT NULL))
    AND ("paused_reason" IS NULL OR "status" IN ('unpublished', 'archived'))
    AND (("paused_reason" IS NULL) OR ("unpublished_at" IS NOT NULL))),
  ADD CONSTRAINT "posts_paused_reason_check" CHECK (
    "paused_reason" IS NULL OR (
      "paused_reason" = btrim("paused_reason") AND char_length("paused_reason") BETWEEN 1 AND 300
      AND "paused_reason" !~ E'[\\u0001-\\u0008\\u000A-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "posts_featured_check" CHECK (NOT "featured" OR "status" = 'published'),
  ADD CONSTRAINT "posts_quota_period_check" CHECK (
    "quota_period" IS NULL
    OR ("owner_type" = 'seller' AND "quota_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
  ADD CONSTRAINT "posts_row_version_check" CHECK ("row_version" >= 0);

ALTER TABLE "blog"."post_versions"
  ADD CONSTRAINT "post_versions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "post_versions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- At most 100 versions per post (the application's MAX_VERSIONS_PER_POST); raising the cap needs
  -- a migration. After 100 versions the editor copies the post into a new one.
  ADD CONSTRAINT "post_versions_version_no_check" CHECK ("version_no" BETWEEN 1 AND 100),
  ADD CONSTRAINT "post_versions_state_check" CHECK (
    "state" IN ('draft', 'in_review', 'returned', 'approved', 'live', 'retired')),
  ADD CONSTRAINT "post_versions_title_check" CHECK (
    "title" = btrim("title") AND char_length("title") BETWEEN 1 AND 120
    AND "title" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]'),
  ADD CONSTRAINT "post_versions_excerpt_check" CHECK (
    char_length("excerpt") <= 160 AND "excerpt" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]'),
  ADD CONSTRAINT "post_versions_body_check" CHECK (
    jsonb_typeof("body") = 'array' AND jsonb_array_length("body") <= 200
    AND octet_length("body"::text) <= 65536),
  ADD CONSTRAINT "post_versions_cover_alt_check" CHECK (
    "cover_alt" IS NULL OR (char_length("cover_alt") <= 200
      AND "cover_alt" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "post_versions_seo_title_check" CHECK (
    "seo_title" IS NULL OR (char_length("seo_title") BETWEEN 1 AND 70
      AND "seo_title" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "post_versions_seo_description_check" CHECK (
    "seo_description" IS NULL OR (char_length("seo_description") BETWEEN 1 AND 160
      AND "seo_description" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "post_versions_author_display_check" CHECK (
    "author_display" IS NULL OR (char_length("author_display") BETWEEN 1 AND 80
      AND "author_display" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "post_versions_submitted_check" CHECK (("submitted_at" IS NULL) = ("submitted_by" IS NULL)),
  ADD CONSTRAINT "post_versions_decision_check" CHECK (
    (("decision" IS NULL) = ("decided_at" IS NULL))
    AND (("decision" IS NULL) = ("decided_by" IS NULL))
    AND ("decision" IS NULL OR "decision" IN ('approved', 'changes_requested'))
    AND ("decision" IS NULL OR "submitted_at" IS NOT NULL)
    AND ("decision" IS DISTINCT FROM 'changes_requested' OR "decision_note" IS NOT NULL)
    AND ("decision" IS NOT NULL OR "decision_note" IS NULL)),
  ADD CONSTRAINT "post_versions_decision_note_check" CHECK (
    "decision_note" IS NULL OR (
      "decision_note" = btrim("decision_note") AND char_length("decision_note") BETWEEN 1 AND 1000
      AND "decision_note" !~ E'[\\u0001-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F<>]')),
  -- The state follows the columns: a draft was never submitted or decided; a version in review was
  -- submitted and not decided; a returned version carries the request; an approved or live
  -- version was approved (a live version of a post that predates review cannot exist).
  ADD CONSTRAINT "post_versions_state_columns_check" CHECK (
    ("state" <> 'draft' OR ("submitted_at" IS NULL AND "decision" IS NULL))
    AND ("state" <> 'in_review' OR ("submitted_at" IS NOT NULL AND "decision" IS NULL))
    AND ("state" <> 'returned' OR "decision" IS NOT DISTINCT FROM 'changes_requested')
    AND ("state" <> 'approved' OR "decision" IS NOT DISTINCT FROM 'approved')
    AND ("state" <> 'live' OR ("decision" IS NOT DISTINCT FROM 'approved' AND "published_at" IS NOT NULL))),
  ADD CONSTRAINT "post_versions_self_approved_check" CHECK (NOT "self_approved" OR "decision" IS NOT DISTINCT FROM 'approved'),
  ADD CONSTRAINT "post_versions_published_check" CHECK (("published_at" IS NULL) = ("published_by" IS NULL));

-- Hand-written: one live version and one open version (draft, in review, returned or approved) per
-- post, so the two pointers of the post can never be ambiguous.
CREATE UNIQUE INDEX "post_versions_one_live_key" ON "blog"."post_versions" ("market_id", "post_id")
  WHERE "state" = 'live';
CREATE UNIQUE INDEX "post_versions_one_open_key" ON "blog"."post_versions" ("market_id", "post_id")
  WHERE "state" IN ('draft', 'in_review', 'returned', 'approved');

-- Hand-written: one featured post per Market; the listing of live posts; the worker's due query.
CREATE UNIQUE INDEX "posts_one_featured_key" ON "blog"."posts" ("market_id") WHERE "featured";
CREATE INDEX "posts_market_id_published_at_published_idx" ON "blog"."posts"
  ("market_id", "published_at" DESC, "id" DESC) WHERE "status" = 'published';
CREATE INDEX "posts_market_id_scheduled_at_idx" ON "blog"."posts" ("market_id", "scheduled_at")
  WHERE "scheduled_at" IS NOT NULL;

ALTER TABLE "blog"."post_events"
  ADD CONSTRAINT "post_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "post_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "post_events_window_check" CHECK (
    "ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '744 hours'),
  ADD CONSTRAINT "post_events_time_zone_check" CHECK (
    "time_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$' AND char_length("time_zone") <= 64),
  ADD CONSTRAINT "post_events_attendance_check" CHECK ("attendance" IN ('offline', 'online', 'mixed')),
  ADD CONSTRAINT "post_events_venue_check" CHECK ("attendance" = 'online' OR "venue_name" IS NOT NULL),
  ADD CONSTRAINT "post_events_venue_name_check" CHECK (
    "venue_name" IS NULL OR (char_length("venue_name") BETWEEN 1 AND 120
      AND "venue_name" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  ADD CONSTRAINT "post_events_address_check" CHECK (
    "address" IS NULL OR (char_length("address") BETWEEN 1 AND 300
      AND "address" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]')),
  -- The one external link of a post: https only, no space, quote, backslash or angle bracket.
  ADD CONSTRAINT "post_events_registration_url_check" CHECK (
    "registration_url" IS NULL
    OR ("registration_url" ~ '^https://[^[:space:]"<>]+$' AND position(chr(92) in "registration_url") = 0
      AND char_length("registration_url") <= 500)),
  ADD CONSTRAINT "post_events_event_status_check" CHECK (
    "event_status" IN ('scheduled', 'postponed', 'rescheduled', 'cancelled')),
  ADD CONSTRAINT "post_events_status_message_check" CHECK (
    "status_message" IS NULL OR (char_length("status_message") BETWEEN 1 AND 300
      AND "status_message" !~ E'[\\u0001-\\u001F\\u007F-\\u009F<>]'));

ALTER TABLE "blog"."post_links"
  ADD CONSTRAINT "post_links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "post_links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "post_links_target_type_check" CHECK (
    "target_type" IN ('product', 'seller', 'brand', 'category', 'page')),
  ADD CONSTRAINT "post_links_position_check" CHECK ("position" BETWEEN 0 AND 29);

ALTER TABLE "blog"."post_tags"
  ADD CONSTRAINT "post_tags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "post_tags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "blog"."redirects"
  ADD CONSTRAINT "redirects_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "redirects_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "redirects_from_slug_check" CHECK (
    "from_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("from_slug") BETWEEN 3 AND 80);

ALTER TABLE "blog"."seller_quotas"
  ADD CONSTRAINT "seller_quotas_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_quotas_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_quotas_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "seller_quotas_used_check" CHECK ("used" BETWEEN 0 AND 1000);

ALTER TABLE "blog"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^blog\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "blog"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

ALTER TABLE "blog"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^blog\.[a-z0-9-]+$');

-- Hand-written: the lifecycle of a version, in the database too. The trigger functions are
-- trigger functions, so they get no grant (platform.md 10.2); they fire for every role, the owner
-- included. (1) The state moves only along the lifecycle and retired is final. (2) Once a version
-- has left `draft` its content columns never change: a reviewer's edit and a new draft are new
-- rows. (3) The links, tags and event details of a version change only while it is a draft; the
-- one exception is the status of an event, which changes at once on any version.
CREATE FUNCTION "blog"."post_versions_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'draft' AND NEW."state" IN ('in_review', 'retired'))
    OR (OLD."state" = 'in_review' AND NEW."state" IN ('approved', 'returned', 'retired'))
    OR (OLD."state" = 'approved' AND NEW."state" IN ('live', 'retired'))
    OR (OLD."state" IN ('returned', 'live') AND NEW."state" = 'retired')) THEN
    RAISE EXCEPTION 'blog.post_versions: the state % cannot become %', OLD."state", NEW."state"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."state" <> 'draft' AND (
    NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."excerpt" IS DISTINCT FROM OLD."excerpt"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."cover_image_id" IS DISTINCT FROM OLD."cover_image_id"
    OR NEW."cover_alt" IS DISTINCT FROM OLD."cover_alt"
    OR NEW."seo_title" IS DISTINCT FROM OLD."seo_title"
    OR NEW."seo_description" IS DISTINCT FROM OLD."seo_description"
    OR NEW."author_display" IS DISTINCT FROM OLD."author_display"
    OR NEW."category_id" IS DISTINCT FROM OLD."category_id") THEN
    RAISE EXCEPTION 'blog.post_versions: the content of a version that left draft is final'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "post_versions_lifecycle"
  BEFORE UPDATE ON "blog"."post_versions"
  FOR EACH ROW EXECUTE FUNCTION "blog"."post_versions_guard_update"();

CREATE FUNCTION "blog"."version_child_requires_draft"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  child_market text;
  child_version uuid;
  parent_state text;
  parent_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    child_market := OLD."market_id";
    child_version := OLD."version_id";
  ELSE
    child_market := NEW."market_id";
    child_version := NEW."version_id";
  END IF;
  SELECT v."state", p."kind" INTO parent_state, parent_kind
    FROM "blog"."post_versions" v
    JOIN "blog"."posts" p ON p."market_id" = v."market_id" AND p."id" = v."post_id"
   WHERE v."market_id" = child_market AND v."id" = child_version;
  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'blog.%: the rows of a version change only while it is a draft', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'post_events' AND TG_OP = 'INSERT' AND parent_kind <> 'event' THEN
    RAISE EXCEPTION 'blog.post_events: only an event post has event details'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "post_links_draft_only"
  BEFORE INSERT OR DELETE ON "blog"."post_links"
  FOR EACH ROW EXECUTE FUNCTION "blog"."version_child_requires_draft"();
CREATE TRIGGER "post_tags_draft_only"
  BEFORE INSERT OR DELETE ON "blog"."post_tags"
  FOR EACH ROW EXECUTE FUNCTION "blog"."version_child_requires_draft"();
CREATE TRIGGER "post_events_draft_only"
  BEFORE INSERT OR DELETE ON "blog"."post_events"
  FOR EACH ROW EXECUTE FUNCTION "blog"."version_child_requires_draft"();

CREATE FUNCTION "blog"."post_events_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_state text;
BEGIN
  IF (NEW."starts_at", NEW."ends_at", NEW."time_zone", NEW."attendance", NEW."venue_name",
      NEW."address", NEW."registration_url")
     IS DISTINCT FROM
     (OLD."starts_at", OLD."ends_at", OLD."time_zone", OLD."attendance", OLD."venue_name",
      OLD."address", OLD."registration_url") THEN
    SELECT "state" INTO parent_state FROM "blog"."post_versions"
     WHERE "market_id" = OLD."market_id" AND "id" = OLD."version_id";
    IF parent_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'blog.post_events: only the status of an event changes after the draft'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "post_events_status_only_after_draft"
  BEFORE UPDATE ON "blog"."post_events"
  FOR EACH ROW EXECUTE FUNCTION "blog"."post_events_guard_update"();

-- Hand-written: a slug is either a post's or an old slug of a post, never both, and never an old
-- slug of another post. The unique keys cover one table each; these two triggers cover the pair.
-- (A post that takes back its own old slug deletes that redirect first.)
CREATE FUNCTION "blog"."posts_guard_slug"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "blog"."redirects"
              WHERE "market_id" = NEW."market_id" AND "from_slug" = NEW."slug") THEN
    RAISE EXCEPTION 'blog.posts: the slug is an old slug of a post' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "posts_slug_not_a_redirect"
  BEFORE INSERT OR UPDATE OF "slug" ON "blog"."posts"
  FOR EACH ROW EXECUTE FUNCTION "blog"."posts_guard_slug"();

CREATE FUNCTION "blog"."redirects_guard_slug"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "blog"."posts"
              WHERE "market_id" = NEW."market_id" AND "slug" = NEW."from_slug") THEN
    RAISE EXCEPTION 'blog.redirects: the slug is a post''s slug' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "redirects_slug_not_a_post"
  BEFORE INSERT ON "blog"."redirects"
  FOR EACH ROW EXECUTE FUNCTION "blog"."redirects_guard_slug"();

-- Grants. A post is created and changed, never deleted (archived instead); its kind, owner and
-- Market never change. A version is created and its working columns change while it is a draft and
-- through the lifecycle (the triggers above hold the rest). The links, tags and event details of a
-- draft are replaced; the redirects are added and, when a post takes back an old slug, deleted. A
-- category's slug never changes. The outbox is written by the unit and marked published by the
-- relay; the inbox is appended to.
GRANT USAGE ON SCHEMA "blog" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("slug", "status", "live_version_id", "draft_version_id", "scheduled_at", "published_at", "unpublished_at", "paused_reason", "featured", "quota_period", "updated_at", "updated_by", "row_version") ON TABLE "blog"."posts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "title", "excerpt", "body", "cover_image_id", "cover_alt", "seo_title", "seo_description", "author_display", "category_id", "updated_at", "submitted_at", "submitted_by", "decided_at", "decided_by", "decision", "decision_note", "self_approved", "published_at", "published_by") ON TABLE "blog"."post_versions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("starts_at", "ends_at", "time_zone", "attendance", "venue_name", "address", "registration_url", "event_status", "status_message") ON TABLE "blog"."post_events" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "blog"."post_links" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "blog"."post_tags" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "blog"."redirects" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("position", "updated_at", "updated_by") ON TABLE "blog"."categories" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("name") ON TABLE "blog"."category_names" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("name") ON TABLE "blog"."tags" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("used", "updated_at") ON TABLE "blog"."seller_quotas" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "blog"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "blog"."inbox" TO "mondapac_app";
