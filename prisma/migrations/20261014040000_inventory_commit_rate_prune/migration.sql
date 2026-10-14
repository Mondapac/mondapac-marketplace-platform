-- Inventory slice 5 (speed mode): the reserve rate counters (inventory design 5.4, Hassan
-- finding 6) and the prune job's index and grant (data design 3.6, 9, migration 4).

-- CreateTable
CREATE TABLE "inventory"."rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- Hand-written: the closed kind list, the hashed subject (HMAC-SHA-256, 32 bytes) and the count.
ALTER TABLE "inventory"."rate_counters"
  ADD CONSTRAINT "rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN ('reserve.account.15min', 'reserve.account.day')),
  ADD CONSTRAINT "rate_counters_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "rate_counters_count_check" CHECK ("count" >= 0);

-- The purge reads the counters whose window started before a cut-off.
CREATE INDEX "rate_counters_market_id_window_started_at_idx" ON "inventory"."rate_counters"("market_id", "window_started_at");

-- The prune job (inventory design 11): terminal reservations by the age of their last status
-- change. Partial, so the index never holds an active or committed row.
CREATE INDEX "reservations_market_id_status_changed_at_terminal_idx" ON "inventory"."reservations" ("market_id", "status_changed_at") WHERE "status" IN ('released', 'expired');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."rate_counters" TO "mondapac_app";
-- DELETE is for the prune job only; the lines go by the cascade, which needs no grant on the child.
GRANT DELETE ON TABLE "inventory"."reservations" TO "mondapac_app";
