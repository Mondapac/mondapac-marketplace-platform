-- The history backfill's progress (dashboards upgrade phase 3, PR 12): one row per Market and kind
-- of fact, holding the window's end (fixed when the backfill starts) and the id cursor of the last
-- page written, so a run that stops, fails or times out goes on from there. The application may
-- write only the cursor columns; a reset (start again from the beginning) is an operator's delete.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."backfill_progress" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "until" TIMESTAMPTZ(6) NOT NULL,
    "after" UUID,
    "pages" INTEGER NOT NULL,
    "failed_facts" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "backfill_progress_pkey" PRIMARY KEY ("market_id","kind")
);

ALTER TABLE "reporting"."backfill_progress"
  ADD CONSTRAINT "backfill_progress_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "backfill_progress_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds')),
  ADD CONSTRAINT "backfill_progress_counts_check" CHECK ("pages" >= 0 AND "failed_facts" >= 0),
  ADD CONSTRAINT "backfill_progress_updated_check" CHECK ("updated_at" >= "started_at"),
  ADD CONSTRAINT "backfill_progress_finished_check" CHECK (
    "finished_at" IS NULL OR ("finished_at" >= "started_at" AND "finished_at" <= "updated_at")
  );

GRANT SELECT, INSERT, UPDATE ("after", "pages", "failed_facts", "updated_at", "finished_at")
  ON TABLE "reporting"."backfill_progress" TO "mondapac_app";
