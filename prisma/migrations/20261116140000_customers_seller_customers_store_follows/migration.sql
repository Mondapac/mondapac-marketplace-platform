-- Customers management phase 3: store follows (engagement) and the seller's customers read model
-- (customers). Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "engagement"."store_follows" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "followed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."outbox" (
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
CREATE TABLE "customers"."seller_customers" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "customer_code" VARCHAR(9) NOT NULL,
    "order_count" INTEGER NOT NULL,
    "first_order_at" TIMESTAMPTZ(6),
    "last_order_at" TIMESTAMPTZ(6),
    "spent_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3),
    "follower" BOOLEAN NOT NULL,
    "followed_at" TIMESTAMPTZ(6),
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_customers_pkey" PRIMARY KEY ("market_id","seller_id","account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_follows_market_id_account_id_seller_id_key" ON "engagement"."store_follows"("market_id", "account_id", "seller_id");

-- CreateIndex
CREATE INDEX "store_follows_market_id_account_id_followed_at_id_idx" ON "engagement"."store_follows"("market_id", "account_id", "followed_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "store_follows_market_id_seller_id_followed_at_idx" ON "engagement"."store_follows"("market_id", "seller_id", "followed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "engagement"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "seller_customers_market_id_seller_id_customer_code_key" ON "customers"."seller_customers"("market_id", "seller_id", "customer_code");

-- CreateIndex
CREATE INDEX "seller_customers_market_id_account_id_idx" ON "customers"."seller_customers"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "seller_customers_market_id_seller_id_last_order_at_account__idx" ON "customers"."seller_customers"("market_id", "seller_id", "last_order_at" DESC NULLS LAST, "account_id" DESC);

-- CreateIndex
CREATE INDEX "seller_customers_market_id_seller_id_followed_at_account_id_idx" ON "customers"."seller_customers"("market_id", "seller_id", "followed_at" DESC NULLS LAST, "account_id" DESC);

-- AddForeignKey: a seller's customer is a customer of the directory; erasing the account (which
-- deletes its directory row) deletes every seller's row of it in the same statement.
ALTER TABLE "customers"."seller_customers" ADD CONSTRAINT "seller_customers_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "engagement"."store_follows"
  ADD CONSTRAINT "store_follows_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_follows_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "engagement"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^engagement\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "customers"."seller_customers"
  ADD CONSTRAINT "seller_customers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_customers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_customers_customer_code_check" CHECK ("customer_code" ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  ADD CONSTRAINT "seller_customers_counts_check" CHECK ("order_count" >= 0 AND "spent_minor" >= 0),
  ADD CONSTRAINT "seller_customers_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "seller_customers_currency_orders_check" CHECK (("order_count" = 0) = ("currency" IS NULL)),
  ADD CONSTRAINT "seller_customers_order_instants_check" CHECK (
    ("order_count" = 0 AND "first_order_at" IS NULL AND "last_order_at" IS NULL)
    OR ("order_count" > 0 AND "first_order_at" IS NOT NULL AND "last_order_at" IS NOT NULL AND "last_order_at" >= "first_order_at")),
  ADD CONSTRAINT "seller_customers_follower_check" CHECK ("follower" = ("followed_at" IS NOT NULL)),
  -- A row exists only while the customer and the seller have a relation.
  ADD CONSTRAINT "seller_customers_relation_check" CHECK ("order_count" > 0 OR "follower" OR "exclusive"),
  ADD CONSTRAINT "seller_customers_updated_at_check" CHECK ("updated_at" >= "created_at");

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "engagement"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants. A follow is added and removed by the customer (and removed at erasure), never changed.
-- The seller's customers read model is written, replaced and removed by the sync. The outbox is
-- written by the unit and marked published by the relay.
GRANT SELECT, INSERT, DELETE ON TABLE "engagement"."store_follows" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "engagement"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "customers"."seller_customers" TO "mondapac_app";
