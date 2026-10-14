-- Cart security M2 (cart design 4, 11, 12; Hassan H-1): the guest-cart rate counters, and the
-- index and grant of the purge job.

-- CreateTable
CREATE TABLE "cart"."rate_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- Hand-written: the closed kind list, the hashed subject (HMAC-SHA-256, 32 bytes) and the count.
ALTER TABLE "cart"."rate_counters"
  ADD CONSTRAINT "rate_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rate_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN ('guest.create.origin.60min', 'guest.write.cart.15min', 'guest.write.origin.15min')),
  ADD CONSTRAINT "rate_counters_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "rate_counters_count_check" CHECK ("count" >= 0);

-- The purge reads the counters whose window started before a cut-off.
CREATE INDEX "rate_counters_market_id_window_started_at_idx" ON "cart"."rate_counters"("market_id", "window_started_at");

-- The purge job (cart design 12): carts by the age of their last change.
CREATE INDEX "carts_market_id_last_changed_at_idx" ON "cart"."carts"("market_id", "last_changed_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cart"."rate_counters" TO "mondapac_app";
-- DELETE is for the purge job only; the lines go by the cascade, which needs no grant on the child.
GRANT DELETE ON TABLE "cart"."carts" TO "mondapac_app";
