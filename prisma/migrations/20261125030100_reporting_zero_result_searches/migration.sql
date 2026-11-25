-- Zero-result searches of each Market day (dashboards v2, phase 2), written once by reporting's hourly
-- snapshot job: the days written (with how many queries were kept) and, per day, the queries the
-- storefront search found nothing for that at least ten distinct signed-in customers searched. Aggregate
-- only: no account, guest or session column. Insert-only for the application (no UPDATE or DELETE grant).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."search_snapshot_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "query_count" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "search_snapshot_days_pkey" PRIMARY KEY ("market_id","market_day")
);

-- CreateTable
CREATE TABLE "reporting"."daily_zero_result_searches" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "query_text" VARCHAR(50) NOT NULL,
    "searcher_count" INTEGER NOT NULL,
    "search_count" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_zero_result_searches_pkey" PRIMARY KEY ("market_id","market_day","query_text")
);

ALTER TABLE "reporting"."search_snapshot_days"
  ADD CONSTRAINT "search_snapshot_days_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "search_snapshot_days_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "search_snapshot_days_query_count_check" CHECK ("query_count" >= 0);

ALTER TABLE "reporting"."daily_zero_result_searches"
  ADD CONSTRAINT "daily_zero_result_searches_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_zero_result_searches_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "daily_zero_result_searches_query_text_check" CHECK (
    char_length("query_text") BETWEEN 2 AND 50
  ),
  -- Hassan's rule: a text searched by fewer than ten distinct customers on the day is never kept.
  ADD CONSTRAINT "daily_zero_result_searches_counts_check" CHECK (
    "searcher_count" >= 10 AND "search_count" >= "searcher_count"
  );

GRANT SELECT, INSERT ON TABLE "reporting"."search_snapshot_days" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "reporting"."daily_zero_result_searches" TO "mondapac_app";
