-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tax";

-- CreateTable
CREATE TABLE "tax"."tax_strategies" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "tax_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_strategies_market_id_created_at_id_idx" ON "tax"."tax_strategies"("market_id", "created_at" DESC, "id" DESC);

-- Hand-written: at most one active strategy per Market.
CREATE UNIQUE INDEX "tax_strategies_one_active_key" ON "tax"."tax_strategies" ("market_id") WHERE "active";

-- Hand-written: scope and value checks. The kinds and the shape of `config` are checked by the
-- application; the database keeps the closed list of kinds and a JSON object.
ALTER TABLE "tax"."tax_strategies"
  ADD CONSTRAINT "tax_strategies_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "tax_strategies_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "tax_strategies_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "tax_strategies_kind_check" CHECK ("kind" IN ('flat-rate', 'by-category')),
  ADD CONSTRAINT "tax_strategies_config_check" CHECK (jsonb_typeof("config") = 'object');

-- Grants. A strategy is inserted, changed (name, parameters, active flag) and removed.
GRANT USAGE ON SCHEMA "tax" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("name", "kind", "config", "active", "updated_at", "updated_by"), DELETE ON TABLE "tax"."tax_strategies" TO "mondapac_app";
