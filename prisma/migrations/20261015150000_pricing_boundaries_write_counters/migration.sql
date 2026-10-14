-- Safety (docs/design/data/pricing.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Phase 4 leftovers: the special-price boundary markers and the job's two discovery indexes
-- (data design 3.5, 6.2, D 11), and the per-account write counters (data design 3.8, design 5.2).

-- CreateIndex
CREATE UNIQUE INDEX "special_price_records_market_id_id_key" ON "pricing"."special_price_records"("market_id", "id");

-- CreateTable
CREATE TABLE "pricing"."special_price_boundaries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "special_record_id" UUID NOT NULL,
    "boundary" TEXT NOT NULL,
    "marked_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "special_price_boundaries_pkey" PRIMARY KEY ("market_id","special_record_id","boundary")
);

-- CreateTable
CREATE TABLE "pricing"."write_rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "write_rate_counters_pkey" PRIMARY KEY ("market_id","kind","actor_account_id")
);

-- CreateIndex
CREATE INDEX "write_rate_counters_market_id_window_started_at_idx" ON "pricing"."write_rate_counters"("market_id", "window_started_at");

-- AddForeignKey
ALTER TABLE "pricing"."special_price_boundaries" ADD CONSTRAINT "special_price_boundaries_special_record_id_fkey" FOREIGN KEY ("market_id", "special_record_id") REFERENCES "pricing"."special_price_records"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the closed lists and the shapes.
ALTER TABLE "pricing"."special_price_boundaries"
  ADD CONSTRAINT "special_price_boundaries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "special_price_boundaries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "special_price_boundaries_boundary_check" CHECK ("boundary" IN ('start', 'end'));

ALTER TABLE "pricing"."write_rate_counters"
  ADD CONSTRAINT "write_rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "write_rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "write_rate_counters_kind_check" CHECK ("kind" IN ('write.account.day', 'write.account.minute')),
  ADD CONSTRAINT "write_rate_counters_count_check" CHECK ("count" >= 0);

-- The boundary job's discovery (data design 6.2, D 11): live specials by the instant of their
-- start and of their natural end; the horizon H keeps the range small, the marker's primary key
-- answers "already announced".
CREATE INDEX "special_price_records_market_id_effective_from_live_idx"
  ON "pricing"."special_price_records" ("market_id", "effective_from")
  WHERE "status" IN ('accepted', 'approved', 'withdrawn');
CREATE INDEX "special_price_records_market_id_ends_at_live_idx"
  ON "pricing"."special_price_records" ("market_id", "ends_at")
  WHERE "status" IN ('accepted', 'approved');

-- Markers are insert-only (PD6): no update, no delete, no truncate. `reject_mutation` is the
-- function of the other append-only tables of this schema.
CREATE TRIGGER "special_price_boundaries_no_update" BEFORE UPDATE ON "pricing"."special_price_boundaries"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "special_price_boundaries_no_delete" BEFORE DELETE ON "pricing"."special_price_boundaries"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "special_price_boundaries_no_truncate" BEFORE TRUNCATE ON "pricing"."special_price_boundaries"
  FOR EACH STATEMENT EXECUTE FUNCTION "pricing"."reject_mutation"();

-- Grants (database-designer): to mondapac_app only. Markers are insert-only; the counters change
-- only their count and window, and are purged.
GRANT SELECT, INSERT ON TABLE "pricing"."special_price_boundaries" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("count", "window_started_at"), DELETE ON TABLE "pricing"."write_rate_counters" TO "mondapac_app";
