-- Admin Import products (catalog design 14a; docs/design/data/catalog.md 3.29): the import job of
-- PLATFORM products and one row of result per data row of its file; three admin counter kinds for the
-- upload (per hour and per day) and the confirm. New, empty tables; the only change to an existing table is the wider
-- kind list of `rate_counters`. The uploaded file is never stored here (ADR-0016).

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."platform_import_jobs" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "started_by_account_id" UUID NOT NULL,
    "started_by_session_id" UUID NOT NULL,
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
    "ignored_columns" JSONB NOT NULL,
    "start_as" TEXT,
    "skip_errors" BOOLEAN,
    "to_import" INTEGER,
    "added_rows" INTEGER NOT NULL,
    "failed_rows" INTEGER NOT NULL,
    "stop_reason" TEXT,
    "not_before" TIMESTAMPTZ(6),
    "lease_until" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."platform_import_rows" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "check_state" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "run_state" TEXT NOT NULL,
    "run_code" TEXT,
    "product_id" UUID,
    "product_code" TEXT,

    CONSTRAINT "platform_import_rows_pkey" PRIMARY KEY ("market_id","job_id","row_number")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_import_jobs_market_id_id_key" ON "catalog"."platform_import_jobs"("market_id", "id");

-- CreateIndex
CREATE INDEX "platform_import_jobs_market_id_account_created_at_idx" ON "catalog"."platform_import_jobs"("market_id", "started_by_account_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "catalog"."platform_import_rows" ADD CONSTRAINT "platform_import_rows_market_id_job_id_fkey" FOREIGN KEY ("market_id", "job_id") REFERENCES "catalog"."platform_import_jobs"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- Hand-written: docs/design/data/catalog.md 3.29, 7.

ALTER TABLE "catalog"."platform_import_jobs"
  ADD CONSTRAINT "platform_import_jobs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_import_jobs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_import_jobs_state_check" CHECK ("state" IN
    ('checked', 'queued', 'running', 'finished', 'stopped', 'discarded')),
  ADD CONSTRAINT "platform_import_jobs_format_check" CHECK ("format" IN ('csv', 'xlsx')),
  -- The label is what the admin sent, cleaned by code: short, no control character.
  ADD CONSTRAINT "platform_import_jobs_file_label_check" CHECK (
    char_length("file_label") BETWEEN 1 AND 80 AND "file_label" !~ '[[:cntrl:]]'),
  -- The key is built by code from the Market and the job id (platform/storage rules).
  ADD CONSTRAINT "platform_import_jobs_file_key_check" CHECK (
    "file_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(/[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,5}$'),
  ADD CONSTRAINT "platform_import_jobs_file_sha256_check" CHECK (octet_length("file_sha256") = 32),
  -- 10 MiB at most (the limit of design 14).
  ADD CONSTRAINT "platform_import_jobs_file_bytes_check" CHECK ("file_bytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "platform_import_jobs_counts_check" CHECK (
    "total_rows" BETWEEN 1 AND 5000
    AND "ready_rows" >= 0 AND "error_rows" >= 0 AND "warning_rows" >= 0
    AND "ready_rows" + "error_rows" = "total_rows"
    AND "warning_rows" <= "total_rows"
    AND "added_rows" >= 0 AND "failed_rows" >= 0),
  ADD CONSTRAINT "platform_import_jobs_start_as_check" CHECK (
    "start_as" IS NULL OR "start_as" IN ('inactive', 'active')),
  -- The choice, the count and the start time are set together, when the import is confirmed; a
  -- discarded job may have been confirmed or not.
  ADD CONSTRAINT "platform_import_jobs_confirmed_check" CHECK (
    "state" = 'discarded'
    OR ("state" = 'checked'
       AND "start_as" IS NULL AND "skip_errors" IS NULL AND "to_import" IS NULL AND "started_at" IS NULL)
    OR ("state" IN ('queued', 'running', 'finished', 'stopped')
       AND "start_as" IS NOT NULL AND "skip_errors" IS NOT NULL AND "to_import" IS NOT NULL
       AND "started_at" IS NOT NULL AND "to_import" BETWEEN 1 AND "total_rows")),
  ADD CONSTRAINT "platform_import_jobs_progress_check" CHECK (
    "added_rows" + "failed_rows" <= COALESCE("to_import", 0)),
  ADD CONSTRAINT "platform_import_jobs_stop_reason_check" CHECK (
    ("state" = 'stopped') = ("stop_reason" IS NOT NULL)
    AND ("stop_reason" IS NULL OR "stop_reason" IN
      ('rate-limited', 'access-lost', 'pause-failed', 'file-missing', 'unexpected'))),
  -- Finished and discarded jobs have an end time; no other job has.
  ADD CONSTRAINT "platform_import_jobs_finished_check" CHECK (
    ("state" IN ('finished', 'discarded')) = ("finished_at" IS NOT NULL)),
  -- The lease is held exactly while a turn runs; a delayed start (`not_before`) belongs to a queued
  -- job only. Every write of the repository keeps both (claim, end of turn, resume, discard).
  ADD CONSTRAINT "platform_import_jobs_lease_check" CHECK (
    ("state" = 'running') = ("lease_until" IS NOT NULL)),
  ADD CONSTRAINT "platform_import_jobs_not_before_check" CHECK (
    "not_before" IS NULL OR "state" = 'queued'),
  ADD CONSTRAINT "platform_import_jobs_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."platform_import_rows"
  ADD CONSTRAINT "platform_import_rows_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "platform_import_rows_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "platform_import_rows_row_number_check" CHECK ("row_number" BETWEEN 2 AND 5002),
  ADD CONSTRAINT "platform_import_rows_check_state_check" CHECK ("check_state" IN ('ready', 'error')),
  ADD CONSTRAINT "platform_import_rows_run_state_check" CHECK ("run_state" IN
    ('pending', 'added', 'failed', 'skipped')),
  ADD CONSTRAINT "platform_import_rows_issues_check" CHECK (
    jsonb_typeof("issues") = 'array' AND jsonb_array_length("issues") <= 12),
  ADD CONSTRAINT "platform_import_rows_summary_check" CHECK (jsonb_typeof("summary") = 'object'),
  ADD CONSTRAINT "platform_import_rows_run_code_check" CHECK (
    ("run_state" = 'failed') = ("run_code" IS NOT NULL)
    AND ("run_code" IS NULL OR "run_code" ~ '^[a-z][a-z0-9_.-]{0,63}$')),
  -- A row is added only with its product (a pending row may already have one: the run records the
  -- product the moment it is created); an error row is never added.
  ADD CONSTRAINT "platform_import_rows_added_check" CHECK (
    ("run_state" <> 'added' OR ("product_id" IS NOT NULL AND "check_state" = 'ready'))
    AND ("run_state" NOT IN ('skipped') OR "product_id" IS NULL)),
  ADD CONSTRAINT "platform_import_rows_product_code_check" CHECK (
    "product_code" IS NULL OR "product_code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');

-- At most one running import per admin (design 14a, as the seller import's one running job): a
-- second confirm while one is queued or running is refused by this index.
CREATE UNIQUE INDEX "platform_import_jobs_market_id_account_running_key"
  ON "catalog"."platform_import_jobs" ("market_id", "started_by_account_id")
  WHERE "state" IN ('queued', 'running');

-- The runner's claim order: the jobs that are due, earliest first. Not CONCURRENTLY: the table is
-- new and empty (8.2).
CREATE INDEX "platform_import_jobs_market_id_queue_idx"
  ON "catalog"."platform_import_jobs" ("market_id", "created_at", "id")
  WHERE "state" IN ('queued', 'running');

-- The purge's range: jobs whose file is still stored.
CREATE INDEX "platform_import_jobs_market_id_file_purge_idx"
  ON "catalog"."platform_import_jobs" ("market_id", "checked_at", "id")
  WHERE "file_deleted_at" IS NULL;

-- The admin counters of the upload (checks per hour and per day) and the confirm (starts per day): the kind
-- list of the counters is a CHECK, so a new kind is this widening (data design 3.26).
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day'));

-- Grants (section 7). The job row moves through its states by column; the rows' results are set
-- as the run goes. DELETE belongs to the purge of 10.4 (old jobs and, with them, their rows).
GRANT SELECT, INSERT, DELETE,
  UPDATE ("state", "file_deleted_at", "start_as", "skip_errors", "to_import", "added_rows",
    "failed_rows", "stop_reason", "not_before", "lease_until", "version", "started_at", "finished_at")
  ON TABLE "catalog"."platform_import_jobs" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE,
  UPDATE ("run_state", "run_code", "product_id", "product_code")
  ON TABLE "catalog"."platform_import_rows" TO "mondapac_app";
