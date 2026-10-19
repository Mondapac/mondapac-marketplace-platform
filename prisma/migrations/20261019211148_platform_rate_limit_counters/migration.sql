-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Generic per-origin rate-limit counters in PostgreSQL (identity design 6.8 and 13; buyer
-- assistant package 1, buyer scale-out item (a)), so every API instance counts one window.
-- The column names, their order and the key shape are fixed by the PostgreSQL store of
-- rate-limiter-flexible 11.2.1, whose INSERT lists no columns. The key carries the keyed hash
-- of the origin, never an address (identity data design HF3). No market_id: the limiter is the
-- cross-Market control (PF I11). Physical design: docs/design/data/platform.md section 12.

-- CreateTable
-- One UPDATE per API request: fillfactor leaves room for HOT updates, and autovacuum runs early.
CREATE TABLE "platform"."rate_limit_counters" (
    "key" VARCHAR(255) NOT NULL,
    "points" INTEGER NOT NULL,
    "expire" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);

-- A new limit class (RATE_LIMIT_CLASSES) needs a migration that widens this CHECK.
ALTER TABLE "platform"."rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|default):[0-9a-f]{64}$'),
  ADD CONSTRAINT "rate_limit_counters_points_check" CHECK ("points" >= 0),
  ADD CONSTRAINT "rate_limit_counters_expire_check" CHECK ("expire" > 0);

-- Grants (database-designer): docs/design/data/platform.md section 12.
-- The store counts with INSERT ... ON CONFLICT DO UPDATE ... RETURNING and purges ended windows.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."rate_limit_counters" TO "mondapac_app";
