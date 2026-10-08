-- CreateTable
CREATE TABLE "platform"."event_delivery" (
    "event_id" UUID NOT NULL,
    "subscriber" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "dead_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_delivery_pkey" PRIMARY KEY ("event_id","subscriber")
);

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.8; the
-- envelope copy has the CHECKs of the outbox (3.1), with the type open to every module. A code
-- column (error_code) holds lower-case segments joined by "." (delivery.not-consumed), at most
-- 64 characters, as on sessions.revoked_reason.
ALTER TABLE "platform"."event_delivery"
  ADD CONSTRAINT "event_delivery_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "event_delivery_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "event_delivery_subscriber_check" CHECK ("subscriber" ~ '^[a-z][a-z0-9-]*\.[a-z0-9-]+$'),
  ADD CONSTRAINT "event_delivery_status_check" CHECK ("status" IN ('pending', 'delivered', 'dead')),
  ADD CONSTRAINT "event_delivery_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "event_delivery_type_check" CHECK ("type" ~ '^[a-z][a-z0-9-]*\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "event_delivery_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "event_delivery_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "event_delivery_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "event_delivery_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "event_delivery_error_code_check" CHECK (
    "error_code" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("error_code") <= 64),
  ADD CONSTRAINT "event_delivery_delivered_check" CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL)),
  ADD CONSTRAINT "event_delivery_dead_check" CHECK (("status" = 'dead') = ("dead_at" IS NOT NULL));

-- Hand-written (database-designer): docs/design/data/identity.md sections 3.8 and 8.4, the
-- dispatcher's claim (platform persistence design 6.4). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "event_delivery_market_id_next_attempt_at_pending_idx" ON "platform"."event_delivery" ("market_id", "next_attempt_at") WHERE "status" = 'pending';

-- Grants (database-designer): docs/design/data/identity.md section 7. The envelope copy is
-- immutable to the application; DELETE arrives with the prune job (P 7).
GRANT SELECT, INSERT, UPDATE ("status", "attempts", "next_attempt_at", "error_code", "delivered_at", "dead_at") ON TABLE "platform"."event_delivery" TO "mondapac_app";
