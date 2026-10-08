-- Safety (docs/design/data/pricing.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "pricing";

-- CreateTable
CREATE TABLE "pricing"."outbox" (
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

-- CreateTable
CREATE TABLE "pricing"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "pricing"."price_series" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "retire_cause" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing"."regular_price_records" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "series_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "tax_inclusive" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,
    "anchor_record_id" UUID,
    "anchor_amount_minor" BIGINT,
    "hold_direction" TEXT,
    "effective_from" TIMESTAMPTZ(6),
    "effective_to" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,
    "decision_reason_code" TEXT,
    "decision_note" TEXT,
    "superseded_at" TIMESTAMPTZ(6),
    "superseded_by_record_id" UUID,
    "supersede_cause" TEXT,

    CONSTRAINT "regular_price_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing"."retired_offers" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ(6) NOT NULL,
    "cause_event_id" UUID NOT NULL,

    CONSTRAINT "retired_offers_pkey" PRIMARY KEY ("market_id","offer_id")
);

-- CreateTable
CREATE TABLE "pricing"."retired_variants" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ(6) NOT NULL,
    "cause_event_id" UUID NOT NULL,

    CONSTRAINT "retired_variants_pkey" PRIMARY KEY ("market_id","product_id","variant_id")
);

-- CreateTable
CREATE TABLE "pricing"."write_refusal_throttles" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "write_refusal_throttles_pkey" PRIMARY KEY ("market_id","actor_account_id","offer_id")
);

-- CreateTable
CREATE TABLE "pricing"."write_refusal_actor_throttles" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_count" INTEGER NOT NULL,
    "suppressed_count" INTEGER NOT NULL,

    CONSTRAINT "write_refusal_actor_throttles_pkey" PRIMARY KEY ("market_id","actor_account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "pricing"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "price_series_market_id_product_id_variant_id_idx" ON "pricing"."price_series"("market_id", "product_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_series_market_id_offer_id_variant_id_key" ON "pricing"."price_series"("market_id", "offer_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_series_market_id_id_currency_key" ON "pricing"."price_series"("market_id", "id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "regular_price_records_market_id_series_id_id_key" ON "pricing"."regular_price_records"("market_id", "series_id", "id");

-- AddForeignKey
ALTER TABLE "pricing"."regular_price_records" ADD CONSTRAINT "regular_price_records_series_id_fkey" FOREIGN KEY ("market_id", "series_id", "currency") REFERENCES "pricing"."price_series"("market_id", "id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pricing"."regular_price_records" ADD CONSTRAINT "regular_price_records_anchor_record_id_fkey" FOREIGN KEY ("market_id", "series_id", "anchor_record_id") REFERENCES "pricing"."regular_price_records"("market_id", "series_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/pricing.md sections 2 (C1-C10, P1-P6), 3.1,
-- 3.2, 3.3, 3.6 and 3.8. Only new tables, so nothing here is NOT VALID. The btree_gist extension
-- the EXCLUDE below needs already exists in schema "extensions" (20261007220000_platform_btree_gist,
-- docs/design/data/sellers.md 9.2), so pricing's migration 1 of 8.1 is not created again (8.3:
-- "the first module that needs it creates it once").
ALTER TABLE "pricing"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^pricing\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "pricing"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^pricing\.[a-z0-9-]+$');

ALTER TABLE "pricing"."price_series"
  ADD CONSTRAINT "price_series_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "price_series_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "price_series_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "price_series_retire_cause_check" CHECK (
    "retire_cause" IN ('offer-removed', 'variant-removed')),
  ADD CONSTRAINT "price_series_retired_check" CHECK (
    ("retired_at" IS NULL) = ("retire_cause" IS NULL)
    AND ("retired_at" IS NULL OR "retired_at" >= "created_at")),
  ADD CONSTRAINT "price_series_version_check" CHECK ("version" >= 1);

-- P1 money, P4 status, P5 write-once columns tied to the statuses that need them (3.3).
ALTER TABLE "pricing"."regular_price_records"
  ADD CONSTRAINT "regular_price_records_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "regular_price_records_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "regular_price_records_amount_minor_check" CHECK (
    "amount_minor" > 0 AND "amount_minor" <= 9007199254740991),
  ADD CONSTRAINT "regular_price_records_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "regular_price_records_status_check" CHECK (
    "status" IN ('accepted', 'pending-review', 'approved', 'rejected', 'superseded')),
  ADD CONSTRAINT "regular_price_records_anchor_check" CHECK (
    ("anchor_record_id" IS NULL) = ("anchor_amount_minor" IS NULL)
    AND ("anchor_record_id" IS NULL OR "anchor_record_id" <> "id")
    AND ("anchor_amount_minor" IS NULL
         OR ("anchor_amount_minor" > 0 AND "anchor_amount_minor" <= 9007199254740991))),
  ADD CONSTRAINT "regular_price_records_hold_direction_check" CHECK (
    ("hold_direction" IS NULL) = ("status" = 'accepted')
    AND ("hold_direction" IS NULL
         OR ("hold_direction" = 'up' AND "amount_minor" > "anchor_amount_minor")
         OR ("hold_direction" = 'down' AND "amount_minor" < "anchor_amount_minor"))
    AND ("hold_direction" IS NULL OR "anchor_record_id" IS NOT NULL)),
  ADD CONSTRAINT "regular_price_records_effective_check" CHECK (
    ("effective_from" IS NOT NULL) = ("status" IN ('accepted', 'approved'))
    AND ("effective_from" IS NULL OR "effective_from" >= "submitted_at")
    AND ("status" <> 'approved' OR "effective_from" >= "decided_at")
    AND ("effective_to" IS NULL OR ("effective_from" IS NOT NULL AND "effective_to" > "effective_from"))),
  ADD CONSTRAINT "regular_price_records_decision_check" CHECK (
    ("decided_at" IS NOT NULL) = ("status" IN ('approved', 'rejected'))
    AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
    AND ("decided_at" IS NULL OR "decided_at" >= "submitted_at")
    AND ("status" <> 'rejected' OR "decision_reason_code" IS NOT NULL)
    AND ("decision_reason_code" IS NULL OR "decided_at" IS NOT NULL)
    AND ("decision_note" IS NULL OR "decided_at" IS NOT NULL)),
  ADD CONSTRAINT "regular_price_records_decider_check" CHECK (
    "decided_by_account_id" IS NULL OR "decided_by_account_id" <> "submitted_by_account_id"),
  ADD CONSTRAINT "regular_price_records_decision_reason_code_check" CHECK (
    "decision_reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  -- Free text, treated as personal: the class of identity's display name (ID-data 3.3), except
  -- that a newline is allowed.
  ADD CONSTRAINT "regular_price_records_decision_note_check" CHECK (
    char_length("decision_note") BETWEEN 1 AND 1000
    AND "decision_note" = btrim("decision_note")
    AND "decision_note" !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "regular_price_records_superseded_check" CHECK (
    ("superseded_at" IS NOT NULL) = ("status" = 'superseded')
    AND ("supersede_cause" IS NOT NULL) = ("status" = 'superseded')
    AND ("superseded_by_record_id" IS NOT NULL) = coalesce("supersede_cause" = 'replaced', false)
    AND ("superseded_by_record_id" IS NULL OR "superseded_by_record_id" <> "id")),
  ADD CONSTRAINT "regular_price_records_supersede_cause_check" CHECK (
    "supersede_cause" IN ('replaced', 'cancelled', 'offer-removed', 'variant-removed'));

-- Regular effective periods never overlap (PD1, ADR-0009 V2; 3.3). Half-open ranges: a period
-- that ends at the instant the next one starts is accepted, and two open periods always overlap,
-- so a series has at most one open period. Rows that are not accepted or approved are outside the
-- constraint. Immediate, not deferrable: a unit closes the open period before it inserts or
-- approves the next one (P7, M1). The equality on market_id and series_id inside a GiST index
-- needs btree_gist, found by its default operator class, so "extensions" need not be on any
-- search_path.
ALTER TABLE "pricing"."regular_price_records"
  ADD CONSTRAINT "regular_price_records_effective_period_excl" EXCLUDE USING gist (
    "market_id" WITH =, "series_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&)
    WHERE ("status" IN ('accepted', 'approved'));

ALTER TABLE "pricing"."retired_offers"
  ADD CONSTRAINT "retired_offers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "retired_offers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "pricing"."retired_variants"
  ADD CONSTRAINT "retired_variants_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "retired_variants_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "pricing"."write_refusal_throttles"
  ADD CONSTRAINT "write_refusal_throttles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "write_refusal_throttles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- The per-actor counter of M7 (D 5.2): a proposed shape, pending database-designer's fold-in
-- into 3.8 (12.1). The cap (20) is policy, not a CHECK.
ALTER TABLE "pricing"."write_refusal_actor_throttles"
  ADD CONSTRAINT "write_refusal_actor_throttles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "write_refusal_actor_throttles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "write_refusal_actor_throttles_counts_check" CHECK (
    "recorded_count" >= 0 AND "suppressed_count" >= 0);

-- Hand-written (database-designer): data design 3.1 (the relay's claim, P 6.1) and 3.3 (PD2, AC
-- 12: at most one pending regular record per series). Invisible to Prisma; checked by the
-- partial-index catalog test.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "pricing"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE UNIQUE INDEX "regular_price_records_market_id_series_id_pending_key"
  ON "pricing"."regular_price_records" ("market_id", "series_id") WHERE "status" = 'pending-review';

-- Hand-written (database-designer): data design 3.3, P5 and P6. Every pricing function is
-- SECURITY INVOKER, pins search_path, schema-qualifies every name and uses no dynamic EXECUTE
-- (platform.md 10.2; Hassan, pricing-data review). Both answer 23001 (restrict_violation) to every
-- role, the owner included. reject_mutation() also serves the record tables of later slices.
CREATE FUNCTION "pricing"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'pricing.%: append-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

-- Record content never changes; status moves only pending-review -> approved, rejected or
-- superseded; a written-once column never changes again; decision columns change only with the
-- status. effective_to is the only column written while the status stays (closing a period).
CREATE FUNCTION "pricing"."regular_price_records_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."amount_minor", NEW."currency",
      NEW."tax_inclusive", NEW."submitted_at", NEW."submitted_by_account_id", NEW."anchor_record_id",
      NEW."anchor_amount_minor", NEW."hold_direction")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."amount_minor", OLD."currency",
      OLD."tax_inclusive", OLD."submitted_at", OLD."submitted_by_account_id", OLD."anchor_record_id",
      OLD."anchor_amount_minor", OLD."hold_direction") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: record content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'pending-review' AND NEW."status" IN ('approved', 'rejected', 'superseded')) THEN
    RAISE EXCEPTION 'pricing.regular_price_records: status % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."effective_from" IS NOT NULL AND NEW."effective_from" IS DISTINCT FROM OLD."effective_from")
     OR (OLD."effective_to" IS NOT NULL AND NEW."effective_to" IS DISTINCT FROM OLD."effective_to")
     OR (OLD."decided_at" IS NOT NULL AND NEW."decided_at" IS DISTINCT FROM OLD."decided_at")
     OR (OLD."decided_by_account_id" IS NOT NULL AND NEW."decided_by_account_id" IS DISTINCT FROM OLD."decided_by_account_id")
     OR (OLD."decision_reason_code" IS NOT NULL AND NEW."decision_reason_code" IS DISTINCT FROM OLD."decision_reason_code")
     OR (OLD."decision_note" IS NOT NULL AND NEW."decision_note" IS DISTINCT FROM OLD."decision_note")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_by_record_id" IS NOT NULL AND NEW."superseded_by_record_id" IS DISTINCT FROM OLD."superseded_by_record_id")
     OR (OLD."supersede_cause" IS NOT NULL AND NEW."supersede_cause" IS DISTINCT FROM OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: a written-once column cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = OLD."status"
     AND (NEW."effective_from", NEW."decided_at", NEW."decided_by_account_id", NEW."decision_reason_code",
          NEW."decision_note", NEW."superseded_at", NEW."superseded_by_record_id", NEW."supersede_cause")
         IS DISTINCT FROM
         (OLD."effective_from", OLD."decided_at", OLD."decided_by_account_id", OLD."decision_reason_code",
          OLD."decision_note", OLD."superseded_at", OLD."superseded_by_record_id", OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: decision columns change only with the status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "regular_price_records_write_once" BEFORE UPDATE ON "pricing"."regular_price_records"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."regular_price_records_guard_update"();
CREATE TRIGGER "regular_price_records_no_delete" BEFORE DELETE ON "pricing"."regular_price_records"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "regular_price_records_no_truncate" BEFORE TRUNCATE ON "pricing"."regular_price_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "pricing"."reject_mutation"();

-- Grants (database-designer): docs/design/data/pricing.md section 7, to mondapac_app only. No
-- DELETE on series, records or tombstones (P6); the throttle counters are purged.
GRANT USAGE ON SCHEMA "pricing" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "pricing"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "pricing"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("retired_at", "retire_cause", "version")
  ON TABLE "pricing"."price_series" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "effective_from", "effective_to", "decided_at",
  "decided_by_account_id", "decision_reason_code", "decision_note", "superseded_at",
  "superseded_by_record_id", "supersede_cause")
  ON TABLE "pricing"."regular_price_records" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "pricing"."retired_offers" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "pricing"."retired_variants" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("window_started_at"), DELETE
  ON TABLE "pricing"."write_refusal_throttles" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("window_started_at", "recorded_count", "suppressed_count"), DELETE
  ON TABLE "pricing"."write_refusal_actor_throttles" TO "mondapac_app";
