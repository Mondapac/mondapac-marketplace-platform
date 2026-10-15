-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema (notifications already exists; ordering too)
CREATE SCHEMA IF NOT EXISTS "ordering";
CREATE SCHEMA IF NOT EXISTS "notifications";

-- CreateTable: ordering publishes `ordering.order-paid.v1`
CREATE TABLE "ordering"."outbox" (
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

-- CreateTable: notifications consumes it (one inbox row per event and handler)
CREATE TABLE "notifications"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "ordering"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- Hand-written: scope and value checks.
ALTER TABLE "ordering"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^ordering\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "notifications"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^notifications\.[a-z0-9-]+$');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "ordering"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants. The outbox is written by the unit and marked published by the relay; the inbox is
-- insert-only.
GRANT USAGE ON SCHEMA "ordering" TO "mondapac_app";
GRANT USAGE ON SCHEMA "notifications" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "ordering"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "notifications"."inbox" TO "mondapac_app";
