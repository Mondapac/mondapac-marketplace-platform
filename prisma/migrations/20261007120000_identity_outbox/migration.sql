-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateTable
CREATE TABLE "identity"."outbox" (
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
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "identity"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.1.
ALTER TABLE "identity"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^identity\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Hand-written (database-designer): docs/design/data/identity.md section 8.4, the relay's claim
-- (platform persistence design 6.1). Invisible to Prisma; checked by the partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "identity"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT USAGE ON SCHEMA "identity" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "identity"."outbox" TO "mondapac_app";
