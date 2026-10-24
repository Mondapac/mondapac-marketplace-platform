-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "storefront"."slides" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "internal_name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "pinned" BOOLEAN NOT NULL,
    "sponsored" BOOLEAN NOT NULL,
    "live_version_id" UUID,
    "draft_version_id" UUID,
    "submitted_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront"."slide_versions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slide_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "internal_name" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "placements" JSONB NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "pinned" BOOLEAN NOT NULL,
    "sponsored" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "slide_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront"."slide_placements" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slide_id" UUID NOT NULL,
    "position_key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" UUID,
    "include_subcategories" BOOLEAN NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "autoplay" BOOLEAN NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slide_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront"."slide_position_locks" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "position_key" TEXT NOT NULL,
    "touched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slide_position_locks_pkey" PRIMARY KEY ("market_id","position_key")
);

-- CreateIndex
CREATE INDEX "slides_market_id_created_at_id_idx" ON "storefront"."slides"("market_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "slides_market_id_id_key" ON "storefront"."slides"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "slide_versions_market_id_slide_id_version_no_key" ON "storefront"."slide_versions"("market_id", "slide_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "slide_versions_market_id_slide_id_id_key" ON "storefront"."slide_versions"("market_id", "slide_id", "id");

-- CreateIndex
CREATE INDEX "slide_placements_market_id_position_key_starts_at_ends_at_idx" ON "storefront"."slide_placements"("market_id", "position_key", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "slide_placements_market_id_slide_id_idx" ON "storefront"."slide_placements"("market_id", "slide_id");

-- AddForeignKey
ALTER TABLE "storefront"."slide_versions" ADD CONSTRAINT "slide_versions_market_id_slide_id_fkey" FOREIGN KEY ("market_id", "slide_id") REFERENCES "storefront"."slides"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storefront"."slides" ADD CONSTRAINT "slides_market_id_id_live_version_id_fkey" FOREIGN KEY ("market_id", "id", "live_version_id") REFERENCES "storefront"."slide_versions"("market_id", "slide_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storefront"."slides" ADD CONSTRAINT "slides_market_id_id_draft_version_id_fkey" FOREIGN KEY ("market_id", "id", "draft_version_id") REFERENCES "storefront"."slide_versions"("market_id", "slide_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storefront"."slides" ADD CONSTRAINT "slides_market_id_id_submitted_version_id_fkey" FOREIGN KEY ("market_id", "id", "submitted_version_id") REFERENCES "storefront"."slide_versions"("market_id", "slide_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storefront"."slide_placements" ADD CONSTRAINT "slide_placements_market_id_slide_id_fkey" FOREIGN KEY ("market_id", "slide_id") REFERENCES "storefront"."slides"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: value checks. The per-kind content schema, the position list, the scope rules per
-- position and the caps are checked by the application; the database keeps the closed kinds,
-- states, scopes, key formats, the window (end required, at most 2160 hours = 90 days after the
-- start, in absolute time so a daylight-saving change cannot move it), and the basic limits of the
-- content, as defence in depth.
ALTER TABLE "storefront"."slides"
  ADD CONSTRAINT "slides_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slides_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slides_kind_check" CHECK ("kind" IN ('announcement', 'promotion', 'link')),
  ADD CONSTRAINT "slides_state_check" CHECK ("state" IN ('draft', 'approved', 'paused', 'archived')),
  ADD CONSTRAINT "slides_internal_name_check" CHECK (char_length("internal_name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "slides_window_check" CHECK (
    "ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '2160 hours'),
  ADD CONSTRAINT "slides_live_check" CHECK (
    ("state" IN ('approved', 'paused') AND "live_version_id" IS NOT NULL)
    OR ("state" = 'draft' AND "live_version_id" IS NULL)
    OR "state" = 'archived');

ALTER TABLE "storefront"."slide_versions"
  ADD CONSTRAINT "slide_versions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_versions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- At most 100 versions per slide (the application's MAX_VERSIONS_PER_SLIDE); raising the cap needs
  -- a migration. After 100 saves the editor copies the slide into a new one.
  ADD CONSTRAINT "slide_versions_version_no_check" CHECK ("version_no" BETWEEN 1 AND 100),
  ADD CONSTRAINT "slide_versions_internal_name_check" CHECK (char_length("internal_name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "slide_versions_content_check" CHECK (
    jsonb_typeof("content") = 'object'
    AND octet_length("content"::text) <= 8192
    AND "content" ? 'title'
    AND jsonb_typeof("content" -> 'title') = 'string'
    AND char_length("content" ->> 'title') BETWEEN 1 AND 60
    AND (NOT "content" ? 'body' OR (jsonb_typeof("content" -> 'body') = 'string'
      AND char_length("content" ->> 'body') <= 160))
    AND (NOT "content" ? 'ctaLabel' OR (jsonb_typeof("content" -> 'ctaLabel') = 'string'
      AND char_length("content" ->> 'ctaLabel') <= 24))),
  ADD CONSTRAINT "slide_versions_placements_check" CHECK (
    jsonb_typeof("placements") = 'array' AND jsonb_array_length("placements") BETWEEN 1 AND 10
    AND octet_length("placements"::text) <= 4096),
  ADD CONSTRAINT "slide_versions_window_check" CHECK (
    "ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '2160 hours'),
  ADD CONSTRAINT "slide_versions_approved_check" CHECK (
    ("approved_by" IS NULL) = ("approved_at" IS NULL));

ALTER TABLE "storefront"."slide_placements"
  ADD CONSTRAINT "slide_placements_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_placements_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slide_placements_position_key_check" CHECK (
    "position_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND char_length("position_key") <= 40),
  ADD CONSTRAINT "slide_placements_scope_check" CHECK (
    ("scope" = 'all' AND "scope_id" IS NULL)
    OR ("scope" IN ('category', 'product', 'seller', 'page') AND "scope_id" IS NOT NULL)),
  ADD CONSTRAINT "slide_placements_subcategories_check" CHECK (
    NOT "include_subcategories" OR "scope" = 'category'),
  ADD CONSTRAINT "slide_placements_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "slide_placements_autoplay_check" CHECK (
    NOT "autoplay" OR "position_key" IN ('home.hero', 'landing.top')),
  ADD CONSTRAINT "slide_placements_window_check" CHECK (
    "ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '2160 hours');

ALTER TABLE "storefront"."slide_position_locks"
  ADD CONSTRAINT "slide_position_locks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_position_locks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slide_position_locks_position_key_check" CHECK (
    "position_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND char_length("position_key") <= 40);

-- Hand-written: a placement is one row per slide, position and scope (a nil uuid stands for "no
-- scope id", so two "all" placements at one position collide).
CREATE UNIQUE INDEX "slide_placements_slide_position_scope_key" ON "storefront"."slide_placements"
  ("market_id", "slide_id", "position_key", "scope", COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid));

-- Hand-written: the approval stamp is write-once. The trigger fires for every role, the owner
-- included; it is a trigger function, so it gets no grant (platform.md 10.2). A row whose approval
-- is not yet stamped may be stamped; after that, no UPDATE of it is allowed at all.
CREATE FUNCTION "storefront"."slide_versions_reject_after_approval"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."approved_at" IS NOT NULL THEN
    RAISE EXCEPTION 'storefront.slide_versions: an approved version is final, % is not allowed', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "slide_versions_write_once_approval"
  BEFORE UPDATE ON "storefront"."slide_versions"
  FOR EACH ROW EXECUTE FUNCTION "storefront"."slide_versions_reject_after_approval"();

-- Grants. A slide is created and changed, never deleted (archived instead); its kind never changes.
-- A version is insert-only: only its approval stamp may be written. A placement is a projection:
-- inserted and deleted, never updated. A position lock is created and touched.
GRANT USAGE ON SCHEMA "storefront" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("internal_name", "state", "starts_at", "ends_at", "pinned", "sponsored", "live_version_id", "draft_version_id", "submitted_version_id", "updated_at", "updated_by", "row_version") ON TABLE "storefront"."slides" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("approved_by", "approved_at") ON TABLE "storefront"."slide_versions" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "storefront"."slide_placements" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("touched_at") ON TABLE "storefront"."slide_position_locks" TO "mondapac_app";
