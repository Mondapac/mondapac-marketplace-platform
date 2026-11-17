-- System requests: reminders for overdue requests (owner decision of 15 Nov 2026).
--   1. requests.last_reminded_at: the time of the last reminder of a request, so the reminder job
--      sends at most one per Market day and a restart never sends twice. Null until the first.
--      The decision guard trigger protects only the decision and supersession columns, so it is
--      unchanged; the application role may update this one column more (column grant below).
--   2. outbox: this module's own outbox, for the reminder event the in-app notice follows. Same
--      table, constraints and grants as every module's outbox (reviews_outbox is the model). The
--      application may insert and read, and the relay marks `published_at`; nothing else changes.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "system_requests"."requests" ADD COLUMN "last_reminded_at" TIMESTAMPTZ(6);

GRANT UPDATE ("last_reminded_at") ON TABLE "system_requests"."requests" TO "mondapac_app";

-- CreateTable
CREATE TABLE "system_requests"."outbox" (
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

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "system_requests"."outbox"("market_id", "aggregate_id", "aggregate_version");

ALTER TABLE "system_requests"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^system-requests\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay reads the unpublished rows of a Market in event order.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "system_requests"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "system_requests"."outbox" TO "mondapac_app";
