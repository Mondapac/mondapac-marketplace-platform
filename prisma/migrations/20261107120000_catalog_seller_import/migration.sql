-- Seller Import (catalog design 14c; docs/design/data/catalog.md 3.31): the import job of one seller's
-- file, one row of result per data row, and one insert-only row per photo the photo step added; four
-- seller counter kinds (checks per hour and per day, photos per minute and per day). It replaces the
-- never-migrated outline of 3.24. New, empty tables; the only change to an existing table is the wider
-- kind list of `rate_counters`. The uploaded file is never stored here (ADR-0016). No price, cost or
-- stock column (ADR-0024 d5).

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."seller_import_jobs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "started_by_account_id" UUID NOT NULL,
    "started_by_session_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "file_label" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_sha256" BYTEA NOT NULL,
    "file_bytes" INTEGER NOT NULL,
    "file_deleted_at" TIMESTAMPTZ(6),
    "total_rows" INTEGER NOT NULL,
    "ready_rows" INTEGER NOT NULL,
    "error_rows" INTEGER NOT NULL,
    "warning_rows" INTEGER NOT NULL,
    "group_count" INTEGER NOT NULL,
    "ignored_columns" JSONB NOT NULL,
    "skip_errors" BOOLEAN,
    "to_import" INTEGER,
    "created_rows" INTEGER NOT NULL,
    "updated_rows" INTEGER NOT NULL,
    "unchanged_rows" INTEGER NOT NULL,
    "failed_rows" INTEGER NOT NULL,
    "stop_reason" TEXT,
    "not_before" TIMESTAMPTZ(6),
    "lease_until" TIMESTAMPTZ(6),
    "last_turn_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "seller_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."seller_import_rows" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "group_row" INTEGER NOT NULL,
    "check_state" TEXT NOT NULL,
    "plan" TEXT,
    "issues" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "run_state" TEXT NOT NULL,
    "run_code" TEXT,
    "product_id" UUID,
    "offer_id" UUID,
    "product_code" TEXT,

    CONSTRAINT "seller_import_rows_pkey" PRIMARY KEY ("market_id","job_id","row_number")
);

-- CreateTable
CREATE TABLE "catalog"."seller_import_photos" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "name_key" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "image_id" UUID,
    "added_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_import_photos_pkey" PRIMARY KEY ("market_id","job_id","name_key")
);

-- CreateIndex
CREATE INDEX "seller_import_jobs_market_id_seller_created_at_idx" ON "catalog"."seller_import_jobs"("market_id", "seller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "seller_import_jobs_market_id_account_created_at_idx" ON "catalog"."seller_import_jobs"("market_id", "started_by_account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "seller_import_jobs_market_id_id_key" ON "catalog"."seller_import_jobs"("market_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."seller_import_rows" ADD CONSTRAINT "seller_import_rows_market_id_job_id_fkey" FOREIGN KEY ("market_id", "job_id") REFERENCES "catalog"."seller_import_jobs"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."seller_import_photos" ADD CONSTRAINT "seller_import_photos_market_id_job_id_fkey" FOREIGN KEY ("market_id", "job_id") REFERENCES "catalog"."seller_import_jobs"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: docs/design/data/catalog.md 3.31, 7.

ALTER TABLE "catalog"."seller_import_jobs"
  ADD CONSTRAINT "seller_import_jobs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_import_jobs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_import_jobs_mode_check" CHECK ("mode" IN ('my-products', 'sell-from-catalogue')),
  ADD CONSTRAINT "seller_import_jobs_state_check" CHECK ("state" IN
    ('checked', 'queued', 'running', 'finished', 'stopped', 'discarded')),
  ADD CONSTRAINT "seller_import_jobs_format_check" CHECK ("format" IN ('csv', 'xlsx')),
  -- The label is what the seller sent, cleaned by code: short, no control character.
  ADD CONSTRAINT "seller_import_jobs_file_label_check" CHECK (
    char_length("file_label") BETWEEN 1 AND 80 AND "file_label" !~ '[[:cntrl:]]'),
  -- The key is built by code from the Market and the job id (platform/storage rules).
  ADD CONSTRAINT "seller_import_jobs_file_key_check" CHECK (
    "file_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(/[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,5}$'),
  ADD CONSTRAINT "seller_import_jobs_file_sha256_check" CHECK (octet_length("file_sha256") = 32),
  -- 10 MiB at most (the limit of design 14).
  ADD CONSTRAINT "seller_import_jobs_file_bytes_check" CHECK ("file_bytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "seller_import_jobs_counts_check" CHECK (
    "total_rows" BETWEEN 1 AND 5000
    AND "ready_rows" >= 0 AND "error_rows" >= 0 AND "warning_rows" >= 0
    AND "ready_rows" + "error_rows" = "total_rows"
    AND "warning_rows" <= "total_rows"
    AND "group_count" BETWEEN 1 AND "total_rows"
    AND "created_rows" >= 0 AND "updated_rows" >= 0 AND "unchanged_rows" >= 0 AND "failed_rows" >= 0),
  ADD CONSTRAINT "seller_import_jobs_ignored_columns_check" CHECK (jsonb_typeof("ignored_columns") = 'array'),
  -- The choice, the count and the start time are set together, when the import is confirmed; a
  -- discarded job may have been confirmed or not.
  ADD CONSTRAINT "seller_import_jobs_confirmed_check" CHECK (
    "state" = 'discarded'
    OR ("state" = 'checked'
       AND "skip_errors" IS NULL AND "to_import" IS NULL AND "started_at" IS NULL)
    OR ("state" IN ('queued', 'running', 'finished', 'stopped')
       AND "skip_errors" IS NOT NULL AND "to_import" IS NOT NULL
       AND "started_at" IS NOT NULL AND "to_import" BETWEEN 1 AND "total_rows")),
  ADD CONSTRAINT "seller_import_jobs_progress_check" CHECK (
    "created_rows" + "updated_rows" + "unchanged_rows" + "failed_rows" <= COALESCE("to_import", 0)),
  ADD CONSTRAINT "seller_import_jobs_stop_reason_check" CHECK (
    ("state" = 'stopped') = ("stop_reason" IS NOT NULL)
    AND ("stop_reason" IS NULL OR "stop_reason" IN
      ('rate-limited', 'access-lost', 'seller-not-eligible', 'file-missing', 'unexpected'))),
  -- Finished and discarded jobs have an end time; no other job has.
  ADD CONSTRAINT "seller_import_jobs_finished_check" CHECK (
    ("state" IN ('finished', 'discarded')) = ("finished_at" IS NOT NULL)),
  -- A stopped job has the time it stopped (the photo window closes seven days after it); no other
  -- job has one (a resume clears it).
  ADD CONSTRAINT "seller_import_jobs_ended_check" CHECK (
    ("state" = 'stopped') = ("ended_at" IS NOT NULL)),
  -- The lease is held exactly while a turn runs; a delayed start (`not_before`) belongs to a queued
  -- job only. Every write of the repository keeps both (claim, end of turn, resume, discard).
  ADD CONSTRAINT "seller_import_jobs_lease_check" CHECK (
    ("state" = 'running') = ("lease_until" IS NOT NULL)),
  ADD CONSTRAINT "seller_import_jobs_not_before_check" CHECK (
    "not_before" IS NULL OR "state" = 'queued'),
  ADD CONSTRAINT "seller_import_jobs_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."seller_import_rows"
  ADD CONSTRAINT "seller_import_rows_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_import_rows_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_import_rows_row_number_check" CHECK ("row_number" BETWEEN 2 AND 5002),
  -- The first row of a group is never after the row itself.
  ADD CONSTRAINT "seller_import_rows_group_row_check" CHECK (
    "group_row" BETWEEN 2 AND 5002 AND "group_row" <= "row_number"),
  ADD CONSTRAINT "seller_import_rows_check_state_check" CHECK ("check_state" IN ('ready', 'error')),
  -- A plan exists exactly for a ready row.
  ADD CONSTRAINT "seller_import_rows_plan_check" CHECK (
    ("check_state" = 'error') = ("plan" IS NULL)
    AND ("plan" IS NULL OR "plan" IN ('create', 'update'))),
  ADD CONSTRAINT "seller_import_rows_run_state_check" CHECK ("run_state" IN
    ('pending', 'created', 'updated', 'unchanged', 'failed', 'skipped')),
  ADD CONSTRAINT "seller_import_rows_issues_check" CHECK (
    jsonb_typeof("issues") = 'array' AND jsonb_array_length("issues") <= 12),
  ADD CONSTRAINT "seller_import_rows_summary_check" CHECK (jsonb_typeof("summary") = 'object'),
  ADD CONSTRAINT "seller_import_rows_run_code_check" CHECK (
    ("run_state" = 'failed') = ("run_code" IS NOT NULL)
    AND ("run_code" IS NULL OR "run_code" ~ '^[a-z][a-z0-9_.-]{0,63}$')),
  -- A row is created, updated or unchanged only with its Offer; an error row is never run.
  ADD CONSTRAINT "seller_import_rows_done_check" CHECK (
    ("run_state" NOT IN ('created', 'updated', 'unchanged')
       OR ("offer_id" IS NOT NULL AND "check_state" = 'ready'))
    AND ("run_state" <> 'skipped' OR "product_id" IS NULL)),
  ADD CONSTRAINT "seller_import_rows_product_code_check" CHECK (
    "product_code" IS NULL OR "product_code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');

ALTER TABLE "catalog"."seller_import_photos"
  ADD CONSTRAINT "seller_import_photos_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_import_photos_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_import_photos_name_key_check" CHECK (
    char_length("name_key") BETWEEN 1 AND 80 AND "name_key" = lower("name_key")
    AND "name_key" !~ '[[:cntrl:]]');
-- The name is reserved first (no image yet) and the image id is set once, after the upload; a
-- reservation that never got its image is taken over after ten minutes (the use case).
COMMENT ON COLUMN "catalog"."seller_import_photos"."image_id" IS
  'null while the name is reserved and the upload runs; set once';

-- At most one queued or running import per seller (design 14c): a second start while one is queued
-- or running is refused by this index, which also serialises two starts, so the daily row sum is
-- read under it.
CREATE UNIQUE INDEX "seller_import_jobs_market_id_seller_running_key"
  ON "catalog"."seller_import_jobs" ("market_id", "seller_id")
  WHERE "state" IN ('queued', 'running');

-- At most one unconfirmed check per account, enforced by the database and not only by the discard
-- in the check's unit (Mojtaba M1).
CREATE UNIQUE INDEX "seller_import_jobs_market_id_account_checked_key"
  ON "catalog"."seller_import_jobs" ("market_id", "started_by_account_id")
  WHERE "state" = 'checked';

-- The 24-hour sum of `to_import` (at most 5 starts a day, so a few rows; Mojtaba M2).
CREATE INDEX "seller_import_jobs_market_id_seller_started_at_idx"
  ON "catalog"."seller_import_jobs" ("market_id", "seller_id", "started_at")
  WHERE "started_at" IS NOT NULL;

-- The runner's claim order: the jobs that are due, the one whose last turn is the oldest first (a
-- job that never had a turn first of all), so a seller with a long file does not hold back the
-- others. Not CONCURRENTLY: the table is new and empty (8.2).
CREATE INDEX "seller_import_jobs_market_id_queue_idx"
  ON "catalog"."seller_import_jobs" ("market_id", "last_turn_at" NULLS FIRST, "created_at", "id")
  WHERE "state" IN ('queued', 'running');

-- The purge's range: jobs whose file is still stored.
CREATE INDEX "seller_import_jobs_market_id_file_purge_idx"
  ON "catalog"."seller_import_jobs" ("market_id", "checked_at", "id")
  WHERE "file_deleted_at" IS NULL;

-- The seller counters of the upload (checks per hour and per day) and of the photo step (per minute
-- and per day); `import-start.seller.day` is already in the list. The kind list of the counters is a
-- CHECK, so a new kind is this widening (data design 3.26).
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day',
    'seller-import-check.seller.hour', 'seller-import-check.seller.day',
    'import-photo.seller.minute', 'import-photo.seller.day'));

-- Grants (section 7). The job row moves through its states by column; the rows' results are set as
-- the run goes. DELETE belongs to the purge of 10.4 (old jobs and, with them, their rows and photos).
-- A photo row is written once and its image id is set once (the only UPDATE grant is that column; the
-- repository's update is conditional on the id being null). No TRUNCATE.
GRANT SELECT, INSERT, DELETE,
  UPDATE ("state", "file_deleted_at", "skip_errors", "to_import", "created_rows", "updated_rows",
    "unchanged_rows", "failed_rows", "stop_reason", "not_before", "lease_until", "last_turn_at", "version",
    "started_at", "finished_at", "ended_at")
  ON TABLE "catalog"."seller_import_jobs" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE,
  UPDATE ("run_state", "run_code", "product_id", "offer_id", "product_code")
  ON TABLE "catalog"."seller_import_rows" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE, UPDATE ("image_id")
  ON TABLE "catalog"."seller_import_photos" TO "mondapac_app";
