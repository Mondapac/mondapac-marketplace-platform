-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema (both exist already)
CREATE SCHEMA IF NOT EXISTS "shipping";
CREATE SCHEMA IF NOT EXISTS "ordering";

-- CreateTable: SHP-02/03, a seller order handed to the real-time carrier.
CREATE TABLE "shipping"."carrier_bookings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "carrier" TEXT NOT NULL,
    "carrier_reference" TEXT NOT NULL,
    "progress" TEXT NOT NULL,
    "carrier_status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "carrier_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the carrier webhook events already taken.
CREATE TABLE "shipping"."carrier_events" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "carrier_events_pkey" PRIMARY KEY ("market_id","carrier","event_id")
);

-- CreateTable: shipping publishes `shipping.carrier-delivery-progressed.v1`.
CREATE TABLE "shipping"."outbox" (
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

-- CreateTable: ordering consumes `ordering.order-paid.v1` (carrier booking) and
-- `shipping.carrier-delivery-progressed.v1` (one inbox row per event and handler).
CREATE TABLE "ordering"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE UNIQUE INDEX "carrier_bookings_market_id_seller_order_id_key" ON "shipping"."carrier_bookings"("market_id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_bookings_market_id_carrier_carrier_reference_key" ON "shipping"."carrier_bookings"("market_id", "carrier", "carrier_reference");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "shipping"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- Hand-written: scope and value checks.
ALTER TABLE "shipping"."carrier_bookings"
  ADD CONSTRAINT "carrier_bookings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "carrier_bookings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "carrier_bookings_carrier_check" CHECK ("carrier" IN ('mondapac-drive')),
  ADD CONSTRAINT "carrier_bookings_carrier_reference_check" CHECK ("carrier_reference" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT "carrier_bookings_progress_check" CHECK ("progress" IN ('booked', 'picked-up', 'delivered', 'exception', 'cancelled')),
  ADD CONSTRAINT "carrier_bookings_carrier_status_check" CHECK ("carrier_status" ~ '^[A-Z][A-Z_]{1,39}$'),
  ADD CONSTRAINT "carrier_bookings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "carrier_bookings_updated_at_check" CHECK ("updated_at" >= "created_at");

ALTER TABLE "shipping"."carrier_events"
  ADD CONSTRAINT "carrier_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "carrier_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "carrier_events_carrier_check" CHECK ("carrier" IN ('mondapac-drive'));

ALTER TABLE "shipping"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^shipping\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "ordering"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^ordering\.[a-z0-9-]+$');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "shipping"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants. A booking is inserted once and only its progress columns change; it is never deleted.
-- The event log and the inbox are insert-only; the outbox is written by the unit and marked
-- published by the relay.
GRANT SELECT, INSERT, UPDATE ("progress", "carrier_status", "version", "updated_at") ON TABLE "shipping"."carrier_bookings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "shipping"."carrier_events" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "shipping"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."inbox" TO "mondapac_app";
