-- Offer review queue backlog alerts (risk-based Offer approval, slice 8): one row for each crossing of
-- a limit of the queue (its size, or the business hours its oldest Offer has waited), open until the
-- queue is back within both limits. The row is what makes an alert fire once per crossing, and the
-- partial unique index lets only one be open per Market, so two overlapping job runs raise it once.
-- No Offer, seller or person is stored. Rows stay: one row per crossing, a handful a year.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "notifications"."offer_queue_backlog_alerts" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "queue_size" INTEGER NOT NULL,
    "cleared_at" TIMESTAMPTZ(6),

    CONSTRAINT "offer_queue_backlog_alerts_pkey" PRIMARY KEY ("market_id","id")
);

-- Hand-written: one open alert per Market.
CREATE UNIQUE INDEX "offer_queue_backlog_alerts_one_open_idx"
  ON "notifications"."offer_queue_backlog_alerts"("market_id") WHERE "cleared_at" IS NULL;

ALTER TABLE "notifications"."offer_queue_backlog_alerts"
  ADD CONSTRAINT "offer_queue_backlog_alerts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_queue_backlog_alerts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_queue_backlog_alerts_reason_check" CHECK ("reason" IN ('age', 'size', 'both')),
  ADD CONSTRAINT "offer_queue_backlog_alerts_queue_size_check" CHECK ("queue_size" >= 0),
  ADD CONSTRAINT "offer_queue_backlog_alerts_cleared_check" CHECK ("cleared_at" IS NULL OR "cleared_at" >= "raised_at");

-- Grants: an alert is inserted when raised and its `cleared_at` set once; it is never deleted.
GRANT SELECT, INSERT ON TABLE "notifications"."offer_queue_backlog_alerts" TO "mondapac_app";
GRANT UPDATE ("cleared_at") ON TABLE "notifications"."offer_queue_backlog_alerts" TO "mondapac_app";
