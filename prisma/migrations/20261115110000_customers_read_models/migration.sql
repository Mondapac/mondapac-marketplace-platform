-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "customers"."customer_directory" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_lower" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL,
    "signed_up_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_directory_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateTable
CREATE TABLE "customers"."customer_stats" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "first_order_at" TIMESTAMPTZ(6),
    "last_order_at" TIMESTAMPTZ(6),
    "order_count" INTEGER NOT NULL,
    "spent_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3),
    "refund_count" INTEGER NOT NULL,
    "refunded_minor" BIGINT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_stats_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateIndex
CREATE INDEX "customer_directory_market_id_signed_up_at_account_id_idx" ON "customers"."customer_directory"("market_id", "signed_up_at" DESC, "account_id" DESC);

-- CreateIndex
CREATE INDEX "customer_stats_market_id_last_order_at_idx" ON "customers"."customer_stats"("market_id", "last_order_at" DESC);

-- Hand-written: the email prefix search (`email_lower LIKE 'term%'`). The predicate (true for every
-- row, the CHECK below keeps the key non-empty) keeps it a partial index, which Prisma does not
-- model and so does not report as drift.
CREATE INDEX "customer_directory_email_prefix_idx" ON "customers"."customer_directory" ("market_id", "email_lower" text_pattern_ops) WHERE "email_lower" <> '';

-- Hand-written: scope and value checks.
ALTER TABLE "customers"."customer_directory"
  ADD CONSTRAINT "customer_directory_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_directory_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "customer_directory_status_check" CHECK ("status" IN ('active', 'disabled')),
  ADD CONSTRAINT "customer_directory_email_lower_check" CHECK ("email_lower" = lower(btrim("email")) AND char_length("email_lower") BETWEEN 3 AND 320);

ALTER TABLE "customers"."customer_stats"
  ADD CONSTRAINT "customer_stats_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_stats_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "customer_stats_counts_check" CHECK ("order_count" >= 0 AND "refund_count" >= 0 AND "spent_minor" >= 0 AND "refunded_minor" >= 0),
  ADD CONSTRAINT "customer_stats_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "customer_stats_order_instants_check" CHECK (
    ("order_count" = 0 AND "first_order_at" IS NULL AND "last_order_at" IS NULL)
    OR ("order_count" > 0 AND "first_order_at" IS NOT NULL AND "last_order_at" IS NOT NULL AND "last_order_at" >= "first_order_at"));

-- Grants. Both tables are read models the application writes and the erasure removes from.
GRANT USAGE ON SCHEMA "customers" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "customers"."customer_directory" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "customers"."customer_stats" TO "mondapac_app";
