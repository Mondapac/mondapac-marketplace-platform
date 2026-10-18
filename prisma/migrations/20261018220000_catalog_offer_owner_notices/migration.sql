-- Certification request C-6 (CERT-45; certification slice 15; Hassan M1, Mojtaba N2): the warning
-- to the Owners of Offers whose badge rests on an expiring manufacturer certificate is sent by a
-- job, one row per Owner with its own marker and retry, not by the event handler
-- (docs/design/data/catalog.md 3.27). A new, empty table.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."offer_owner_notices" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_event_id" UUID NOT NULL,
    "product_certification_id" UUID NOT NULL,
    "threshold_days" INTEGER NOT NULL,
    "seller_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "offers" INTEGER NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "offer_owner_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offer_owner_notices_market_id_id_key" ON "catalog"."offer_owner_notices"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_owner_notices_market_id_source_event_id_seller_id_typ_key" ON "catalog"."offer_owner_notices"("market_id", "source_event_id", "seller_id", "type_code");


-- Hand-written: docs/design/data/catalog.md 3.27, 7.

ALTER TABLE "catalog"."offer_owner_notices"
  ADD CONSTRAINT "offer_owner_notices_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_owner_notices_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_owner_notices_type_code_check" CHECK ("type_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_owner_notices_threshold_days_check" CHECK ("threshold_days" BETWEEN 1 AND 366),
  ADD CONSTRAINT "offer_owner_notices_offers_check" CHECK ("offers" > 0),
  ADD CONSTRAINT "offer_owner_notices_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "offer_owner_notices_state_check" CHECK ("state" IN
    ('pending', 'sent', 'skipped', 'failed')),
  -- Pending and sent rows carry no outcome; a skipped or failed one names why.
  ADD CONSTRAINT "offer_owner_notices_outcome_check" CHECK (
    ("outcome" IS NULL) = ("state" IN ('pending', 'sent'))
    AND ("outcome" IS NULL OR "outcome" IN ('no-address', 'past-validity', 'send-failed'))),
  ADD CONSTRAINT "offer_owner_notices_settled_check" CHECK (
    ("state" = 'pending') = ("settled_at" IS NULL));

-- The job's claim order: pending rows that are due, earliest first. Not CONCURRENTLY: the table
-- is new and empty (8.2).
CREATE INDEX "offer_owner_notices_market_id_next_attempt_at_pending_idx"
  ON "catalog"."offer_owner_notices" ("market_id", "next_attempt_at", "id")
  WHERE "state" = 'pending';

-- Grants (section 7): no DELETE until the purge of 10.3 lands (as 3.18).
GRANT SELECT, INSERT, UPDATE ("state", "outcome", "attempts", "next_attempt_at", "settled_at")
  ON TABLE "catalog"."offer_owner_notices" TO "mondapac_app";
