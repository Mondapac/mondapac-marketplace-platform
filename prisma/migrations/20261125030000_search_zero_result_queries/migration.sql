-- Zero-result searches (dashboards v2, phase 2): the storefront search notes on the server the folded
-- text of a plain text search that found nothing, once per UTC quarter hour. No session, account,
-- guest, IP address or device column. The application inserts (ON CONFLICT DO NOTHING), reads the
-- texts of a window for reporting's snapshot and deletes rows older than 35 days; it never updates.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "search"."zero_result_queries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "query_key" VARCHAR(50) NOT NULL,

    CONSTRAINT "zero_result_queries_pkey" PRIMARY KEY ("market_id","bucket_start","query_key")
);

ALTER TABLE "search"."zero_result_queries"
  ADD CONSTRAINT "zero_result_queries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "zero_result_queries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The folded text: 2 to 50 characters, no e-mail address. (The application folds the case; no
  -- lower() CHECK here, as PostgreSQL's and JavaScript's case mappings may differ.)
  ADD CONSTRAINT "zero_result_queries_query_key_check" CHECK (
    char_length("query_key") BETWEEN 2 AND 50
    AND position('@' IN "query_key") = 0
  ),
  -- A quarter-hour boundary, so a Market day of any zone in use is a whole number of buckets.
  ADD CONSTRAINT "zero_result_queries_bucket_start_check" CHECK (
    mod(extract(epoch FROM "bucket_start")::numeric, 900) = 0
  );

GRANT SELECT, INSERT, DELETE ON TABLE "search"."zero_result_queries" TO "mondapac_app";
