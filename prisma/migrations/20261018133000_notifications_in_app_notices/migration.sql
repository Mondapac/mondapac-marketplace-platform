-- In-app notifications package 1: the notices a panel shows under its bell, and who has read
-- each one. A notice is addressed to an audience (a seller today), not to each person; the
-- permission its kind needs is checked when it is read. No text and no personal data: `params`
-- holds ids and counts only. Retention 90 days, at most 200 notices per seller (the purge job
-- and the writer delete the rest).

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "notifications"."in_app_notices" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "seller_id" UUID,
    "kind" VARCHAR(64) NOT NULL,
    "params" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "in_app_notices_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "notifications"."in_app_notice_reads" (
    "market_id" VARCHAR(8) NOT NULL,
    "notice_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "in_app_notice_reads_pkey" PRIMARY KEY ("market_id","notice_id","account_id")
);

-- CreateIndex: the seller's list and count, newest first.
CREATE INDEX "in_app_notices_market_id_seller_id_id_idx" ON "notifications"."in_app_notices"("market_id", "seller_id", "id" DESC);

-- CreateIndex: the retention purge.
CREATE INDEX "in_app_notices_market_id_created_at_idx" ON "notifications"."in_app_notices"("market_id", "created_at");

-- AddForeignKey: a read goes with its notice.
ALTER TABLE "notifications"."in_app_notice_reads" ADD CONSTRAINT "in_app_notice_reads_market_id_notice_id_fkey" FOREIGN KEY ("market_id", "notice_id") REFERENCES "notifications"."in_app_notices"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "notifications"."in_app_notices"
  ADD CONSTRAINT "in_app_notices_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "in_app_notices_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "in_app_notices_audience_check" CHECK ("audience" IN ('seller')),
  ADD CONSTRAINT "in_app_notices_seller_id_check" CHECK (("audience" = 'seller') = ("seller_id" IS NOT NULL)),
  ADD CONSTRAINT "in_app_notices_kind_check" CHECK ("kind" ~ '^[a-z][a-z0-9-]*([.][a-z0-9-]+)+$'),
  ADD CONSTRAINT "in_app_notices_params_check" CHECK (
    jsonb_typeof("params") = 'object' AND octet_length("params"::text) <= 1024);

ALTER TABLE "notifications"."in_app_notice_reads"
  ADD CONSTRAINT "in_app_notice_reads_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "in_app_notice_reads_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- Grants. A notice is written once and deleted by retention, never updated; a read is
-- insert-only and leaves with its notice (the cascade runs as the table owner).
GRANT SELECT, INSERT, DELETE ON TABLE "notifications"."in_app_notices" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "notifications"."in_app_notice_reads" TO "mondapac_app";
