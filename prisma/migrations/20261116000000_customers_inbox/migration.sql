-- The customers module's inbox (ADR-0006 decision 5). The read model subscribers of customers
-- phase 1 (package B1: identity's account events, ordering's order-paid and refund-succeeded)
-- handle each event through `runOnce`, which writes (event_id, handler) here in the handler's own
-- unit. Without this table every delivery to a customers subscriber failed with "Module
-- customers has no inbox model" and was retried until dead-lettered, so the customers read models
-- were kept only by the nightly reconcile.

-- CreateTable
CREATE TABLE "customers"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- Hand-written: scope and handler checks, as every module's inbox.
ALTER TABLE "customers"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^customers\.[a-z0-9-]+$');

-- Grants: appended to only; DELETE arrives with the prune job, as for every inbox.
GRANT SELECT, INSERT ON TABLE "customers"."inbox" TO "mondapac_app";
