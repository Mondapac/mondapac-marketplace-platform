-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "customers"."account_deletion_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "waiting_period_days" SMALLINT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_deletion_requests_market_id_status_scheduled_for_idx" ON "customers"."account_deletion_requests"("market_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "account_deletion_requests_market_id_account_id_requested_at_idx" ON "customers"."account_deletion_requests"("market_id", "account_id", "requested_at" DESC);

-- Hand-written: scope, status and consistency checks.
ALTER TABLE "customers"."account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "account_deletion_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "account_deletion_requests_status_check" CHECK ("status" IN ('pending', 'cancelled', 'completed')),
  ADD CONSTRAINT "account_deletion_requests_waiting_period_days_check" CHECK ("waiting_period_days" BETWEEN 7 AND 90),
  ADD CONSTRAINT "account_deletion_requests_scheduled_for_check" CHECK ("scheduled_for" > "requested_at"),
  ADD CONSTRAINT "account_deletion_requests_cancel_reason_check" CHECK ("cancel_reason" IN ('customer', 'sign-in')),
  ADD CONSTRAINT "account_deletion_requests_closing_columns_check" CHECK (
    ("status" = 'pending' AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL AND "completed_at" IS NULL)
    OR ("status" = 'completed' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL)
  );

-- Hand-written: one pending request per account. The use case also runs in a serializable unit.
CREATE UNIQUE INDEX "account_deletion_requests_one_pending_idx"
  ON "customers"."account_deletion_requests" ("market_id", "account_id") WHERE "status" = 'pending';

-- Grants. A request is inserted, then closed once: the application may update only the closing
-- columns and may not delete, so the history of requests stays.
GRANT SELECT, INSERT, UPDATE ("status", "cancelled_at", "cancel_reason", "completed_at")
  ON TABLE "customers"."account_deletion_requests" TO "mondapac_app";
