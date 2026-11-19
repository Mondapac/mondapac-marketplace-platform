-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health: a request to measure one seller again now ("Recalculate now" of the admin, later
-- "Refresh now" of the seller). New and empty, so there is no backfill.

-- CreateTable
CREATE TABLE "sellers"."seller_health_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "seller_health_requests_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "sellers"."seller_health_requests" ADD CONSTRAINT "seller_health_requests_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. A request is finished exactly when it is not pending.
ALTER TABLE "sellers"."seller_health_requests"
  ADD CONSTRAINT "seller_health_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_health_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_health_requests_source_check" CHECK ("source" IN ('admin', 'seller')),
  ADD CONSTRAINT "seller_health_requests_status_check" CHECK ("status" IN ('pending', 'done', 'failed')),
  ADD CONSTRAINT "seller_health_requests_finished_check" CHECK (("status" = 'pending') = ("finished_at" IS NULL));

-- One pending request per seller: a second click while one waits adds nothing.
CREATE UNIQUE INDEX "seller_health_requests_market_id_seller_id_pending_key"
  ON "sellers"."seller_health_requests" ("market_id", "seller_id") WHERE "status" = 'pending';

-- The pick-up job reads the oldest pending requests of a Market (a small set).
CREATE INDEX "seller_health_requests_market_id_requested_at_pending_idx"
  ON "sellers"."seller_health_requests" ("market_id", "requested_at") WHERE "status" = 'pending';

-- The latest request of a seller, for the card's "queued" state and the seller's cooldown.
CREATE INDEX "seller_health_requests_market_id_seller_id_requested_at_idx"
  ON "sellers"."seller_health_requests" ("market_id", "seller_id", "requested_at" DESC);

-- Grants (database-designer). A request is inserted, then finished once (status and finished_at);
-- its other columns never change and it is never deleted by the app.
GRANT SELECT, INSERT, UPDATE ("status", "finished_at") ON TABLE "sellers"."seller_health_requests" TO "mondapac_app";
