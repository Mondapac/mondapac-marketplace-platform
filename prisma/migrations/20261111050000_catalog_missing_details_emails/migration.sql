-- "Email sellers" for the Missing details report (attributes package A4-4). Creates
-- catalog.missing_details_emails: one row per seller and product asked, the throttle (one request
-- per seller and product in 7 days) and the queue the mail job reads. Nothing is backfilled.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."missing_details_emails" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_name" TEXT,
    "product_name" TEXT NOT NULL,
    "missing_labels" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "requested_by" UUID NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "missing_details_emails_pkey" PRIMARY KEY ("market_id","seller_id","product_id")
);

-- Hand-written: the queue the job reads is the pending rows only, in the order it sends them.
CREATE INDEX "missing_details_emails_pending_idx" ON "catalog"."missing_details_emails"
  ("market_id", "requested_at", "seller_id", "product_id") WHERE "state" = 'pending';

-- Hand-written: CHECKs.
ALTER TABLE "catalog"."missing_details_emails"
  ADD CONSTRAINT "missing_details_emails_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "missing_details_emails_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "missing_details_emails_seller_name_check" CHECK (
    "seller_name" IS NULL OR length("seller_name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "missing_details_emails_product_name_check" CHECK (length("product_name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "missing_details_emails_missing_labels_check" CHECK (
    jsonb_typeof("missing_labels") = 'array' AND jsonb_array_length("missing_labels") BETWEEN 1 AND 50),
  ADD CONSTRAINT "missing_details_emails_state_check" CHECK ("state" IN ('pending', 'sent', 'skipped', 'failed')),
  ADD CONSTRAINT "missing_details_emails_outcome_check" CHECK (
    ("state" IN ('pending', 'sent') AND "outcome" IS NULL)
    OR ("state" = 'skipped' AND "outcome" IS NOT NULL AND "outcome" = 'no-address')
    OR ("state" = 'failed' AND "outcome" IS NOT NULL AND "outcome" = 'send-failed')),
  ADD CONSTRAINT "missing_details_emails_attempts_check" CHECK ("attempts" BETWEEN 0 AND 10),
  ADD CONSTRAINT "missing_details_emails_settled_check" CHECK (("state" = 'pending') = ("settled_at" IS NULL));

-- Grants (database-designer). A request is claimed again after 7 days by replacing its content, so
-- the content columns are updatable; the keys, the tenant and the rows themselves never change or
-- leave (no DELETE): the table keeps the latest request per seller and product (history is in the audit log).
GRANT SELECT, INSERT, UPDATE (
  "seller_name", "product_name", "missing_labels", "state", "outcome", "attempts",
  "requested_at", "requested_by", "settled_at"
) ON TABLE "catalog"."missing_details_emails" TO "mondapac_app";
