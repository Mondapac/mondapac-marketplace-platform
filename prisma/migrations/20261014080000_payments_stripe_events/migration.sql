-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payments";

-- CreateTable
CREATE TABLE "payments"."stripe_events" (
    "event_id" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "outcome" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("market_id","event_id")
);

-- CreateIndex
CREATE INDEX "stripe_events_market_id_processed_at_next_attempt_at_idx" ON "payments"."stripe_events"("market_id", "processed_at", "next_attempt_at");

-- Hand-written: scope and value checks.
ALTER TABLE "payments"."stripe_events"
  ADD CONSTRAINT "stripe_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "stripe_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "stripe_events_event_id_check" CHECK ("event_id" ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^cs_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed')),
  ADD CONSTRAINT "stripe_events_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed')));

-- Grants. The receiver inserts an event once; the worker counts its attempts and marks it done.
-- No row is deleted by the application.
GRANT USAGE ON SCHEMA "payments" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("attempts", "next_attempt_at", "processed_at", "outcome") ON TABLE "payments"."stripe_events" TO "mondapac_app";
