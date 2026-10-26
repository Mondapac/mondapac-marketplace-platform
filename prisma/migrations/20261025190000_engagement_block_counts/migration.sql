-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "engagement"."block_counts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "page_id" UUID NOT NULL,
    "placement_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "block_counts_pkey" PRIMARY KEY ("market_id","page_id","day","placement_id")
);

-- CreateIndex
CREATE INDEX "block_counts_market_id_day_idx" ON "engagement"."block_counts"("market_id", "day");

-- Hand-written: scope and non-negative counts. The primary key is (market_id, page_id, day,
-- placement_id), so the admin read of one page's blocks over a range of days is a tight
-- primary-key range; the index above serves the retention purge.
-- Aggregate only: the table has no account, guest token, cookie, IP address or user agent column.
ALTER TABLE "engagement"."block_counts"
  ADD CONSTRAINT "block_counts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "block_counts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "block_counts_impressions_check" CHECK ("impressions" >= 0),
  ADD CONSTRAINT "block_counts_clicks_check" CHECK ("clicks" >= 0);

-- Grants. A count is inserted on its first event of the day, then only its counters and time are
-- changed (the upsert); the retention purge deletes rows past 13 months.
GRANT SELECT, INSERT, UPDATE ("impressions", "clicks", "updated_at"), DELETE ON TABLE "engagement"."block_counts" TO "mondapac_app";
