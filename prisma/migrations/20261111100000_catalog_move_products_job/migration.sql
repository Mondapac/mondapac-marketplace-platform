-- Categories package C5a, Move products (decision 8; handoffs categories-c5-products and the C5
-- amendments): a new revision kind `category-override` (an admin revision built on the published one,
-- published at once, like `tax-override`), the job that moves every product of a platform category X
-- to a category Y, and one row per product of the job. The tables are new and empty; the only change
-- to an existing table is the wider kind list of `product_revisions` and its two new CHECKs.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."category_product_move_jobs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_category_id" UUID NOT NULL,
    "target_category_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "cursor_product_id" UUID,
    "total_count" INTEGER NOT NULL,
    "moved_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "lease_holder" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "category_product_move_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."category_product_move_items" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "revision_id" UUID,
    "seller_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_product_move_items_pkey" PRIMARY KEY ("market_id","job_id","product_id")
);

-- CreateIndex
CREATE INDEX "category_product_move_jobs_market_id_source_created_at_idx" ON "catalog"."category_product_move_jobs"("market_id", "source_category_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "category_product_move_jobs_market_id_id_key" ON "catalog"."category_product_move_jobs"("market_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."category_product_move_jobs" ADD CONSTRAINT "category_product_move_jobs_market_id_source_category_id_fkey" FOREIGN KEY ("market_id", "source_category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_product_move_jobs" ADD CONSTRAINT "category_product_move_jobs_market_id_target_category_id_fkey" FOREIGN KEY ("market_id", "target_category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_product_move_items" ADD CONSTRAINT "category_product_move_items_market_id_job_id_fkey" FOREIGN KEY ("market_id", "job_id") REFERENCES "catalog"."category_product_move_jobs"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_product_move_items" ADD CONSTRAINT "category_product_move_items_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_product_move_items" ADD CONSTRAINT "category_product_move_items_market_id_product_id_revision__fkey" FOREIGN KEY ("market_id", "product_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written.

-- The new revision kind. A category override is, like a tax override, always built on the published
-- revision and written by an admin. The kind list is a CHECK, so a new kind is this swap: the old
-- CHECK is dropped and the wider CHECK and the two new ones are added NOT VALID, then validated.
-- Every existing row holds a narrower kind, so the validation cannot fail. Lock note: this file runs
-- in one implicit transaction, so the ACCESS EXCLUSIVE lock the DROP CONSTRAINT / ADD CONSTRAINT
-- take is held through the three VALIDATEs, which therefore scan `product_revisions` under it (reads
-- and writes of the table wait for the scan). Acceptable here: the table is small in every
-- environment today. A large environment would need the VALIDATEs in a second migration file (its
-- own transaction, SHARE UPDATE EXCLUSIVE, reads and writes go on; 8.2).
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_kind_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_kind_check" CHECK (
    "revision_kind" IN ('submission', 'revert', 'tax-override', 'category-override')) NOT VALID,
  ADD CONSTRAINT "product_revisions_category_override_base_check" CHECK (
    "revision_kind" <> 'category-override' OR "base_revision_id" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "product_revisions_category_override_author_check" CHECK (
    "revision_kind" <> 'category-override' OR "author_kind" = 'admin') NOT VALID;
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_kind_check";
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_category_override_base_check";
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_category_override_author_check";

ALTER TABLE "catalog"."category_product_move_jobs"
  ADD CONSTRAINT "category_product_move_jobs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_product_move_jobs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_product_move_jobs_categories_check" CHECK (
    "source_category_id" <> "target_category_id"),
  -- The admin's reason: 10 to 500 characters, trimmed by code; line breaks allowed, no other control
  -- character.
  ADD CONSTRAINT "category_product_move_jobs_reason_check" CHECK (
    char_length("reason") BETWEEN 10 AND 500
    AND "reason" = btrim("reason")
    AND "reason" !~ '[\x01-\x09\x0B\x0C\x0E-\x1F\x7F]'),
  ADD CONSTRAINT "category_product_move_jobs_state_check" CHECK (
    "state" IN ('queued', 'running', 'done', 'failed')),
  -- Each counter is non-negative. No bound by the total: the total is the count at the start (a
  -- display snapshot) and a product published into the source after the start is moved too, so the
  -- handled counts may pass it; a bound would wedge such a job (its counters could not advance).
  ADD CONSTRAINT "category_product_move_jobs_counts_check" CHECK (
    "total_count" >= 0 AND "moved_count" >= 0 AND "skipped_count" >= 0 AND "failed_count" >= 0),
  -- A queued job has not started; every other job has. Done and failed jobs have an end time; no
  -- other job has.
  ADD CONSTRAINT "category_product_move_jobs_started_check" CHECK (
    ("state" = 'queued') = ("started_at" IS NULL)),
  ADD CONSTRAINT "category_product_move_jobs_finished_check" CHECK (
    ("state" IN ('done', 'failed')) = ("finished_at" IS NOT NULL)),
  -- The lease (holder and expiry together) is held exactly while the job runs; a runner that finds an
  -- expired lease takes it over with a new holder at the next version.
  ADD CONSTRAINT "category_product_move_jobs_lease_check" CHECK (
    ("lease_holder" IS NULL) = ("lease_expires_at" IS NULL)
    AND ("state" = 'running') = ("lease_expires_at" IS NOT NULL)),
  ADD CONSTRAINT "category_product_move_jobs_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."category_product_move_items"
  ADD CONSTRAINT "category_product_move_items_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_product_move_items_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_product_move_items_state_check" CHECK (
    "state" IN ('pending', 'moved', 'skipped', 'failed')),
  -- A moved product names the revision the move published; no other row names one. The seller is
  -- emailed only about a moved product.
  ADD CONSTRAINT "category_product_move_items_revision_check" CHECK (
    ("state" = 'moved') = ("revision_id" IS NOT NULL)),
  ADD CONSTRAINT "category_product_move_items_notified_check" CHECK (
    "seller_notified_at" IS NULL OR "state" = 'moved');

-- At most one queued or running job per source category (decision 8): a second start is refused by
-- this index, which also serialises two starts. Not CONCURRENTLY: the table is new and empty (8.2).
CREATE UNIQUE INDEX "category_product_move_jobs_market_id_source_open_key"
  ON "catalog"."category_product_move_jobs" ("market_id", "source_category_id")
  WHERE "state" IN ('queued', 'running');

-- The runner's claim order: the open jobs, oldest first.
CREATE INDEX "category_product_move_jobs_market_id_queue_idx"
  ON "catalog"."category_product_move_jobs" ("market_id", "created_at", "id")
  WHERE "state" IN ('queued', 'running');

-- The runner's seller-notice scan: the moved items of a job whose seller has not been emailed yet,
-- by product (the order it pages in). Partial, so it holds only the not-yet-notified rows.
CREATE INDEX "category_product_move_items_market_id_job_id_unnotified_idx"
  ON "catalog"."category_product_move_items" ("market_id", "job_id", "product_id")
  WHERE "state" = 'moved' AND "seller_notified_at" IS NULL;

-- No index on the item foreign keys to products and product_revisions: item rows are never deleted
-- and those parents are never deleted either (RESTRICT, insert-only revisions), so no delete has to
-- look items up by them.

-- Grants (section 7). The job moves through its states by column; its source, target, reason and
-- author are written once. An item is written once and only its outcome changes (state, the
-- published revision, the time the seller's email was queued). No DELETE (the jobs are the audit
-- trail of a bulk publish) and no TRUNCATE.
GRANT SELECT, INSERT,
  UPDATE ("state", "started_at", "finished_at", "cursor_product_id", "total_count", "moved_count",
    "skipped_count", "failed_count", "lease_holder", "lease_expires_at", "version")
  ON TABLE "catalog"."category_product_move_jobs" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "revision_id", "seller_notified_at")
  ON TABLE "catalog"."category_product_move_items" TO "mondapac_app";
