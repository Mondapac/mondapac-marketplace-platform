-- Seller culture membership (multi-culture package 2; ADR-0047 decision 3, ADR-0048). A seller asks to join a
-- culture and a reviewer decides. culture_id and culture_code are plain values of catalog's culture:
-- no foreign key across schemas. Nothing is backfilled here: sellers' own job attaches existing sellers (ADR-0048).
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "sellers"."seller_cultures" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "culture_id" UUID NOT NULL,
    "culture_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "requested_by" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_cultures_pkey" PRIMARY KEY ("market_id","seller_id","culture_id")
);

-- CreateIndex
CREATE INDEX "seller_cultures_market_id_culture_id_status_idx" ON "sellers"."seller_cultures"("market_id", "culture_id", "status");

-- AddForeignKey
ALTER TABLE "sellers"."seller_cultures" ADD CONSTRAINT "seller_cultures_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. A decided row has a time; a requested row has neither who nor when. A NULL
-- requested_by or decided_by is the system at signup (ADR-0048); a rejection is always a person's,
-- with a reason.
ALTER TABLE "sellers"."seller_cultures"
  ADD CONSTRAINT "seller_cultures_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_cultures_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_cultures_culture_code_check" CHECK (
    "culture_code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("culture_code") <= 40),
  ADD CONSTRAINT "seller_cultures_status_check" CHECK ("status" IN ('requested', 'approved', 'rejected')),
  ADD CONSTRAINT "seller_cultures_reason_check" CHECK (
    "reason" IS NULL OR ("reason" = btrim("reason") AND length("reason") BETWEEN 1 AND 300)),
  ADD CONSTRAINT "seller_cultures_decision_check" CHECK (
    ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL)
    OR ("status" <> 'requested' AND "decided_at" IS NOT NULL)),
  ADD CONSTRAINT "seller_cultures_rejection_check" CHECK (
    "status" <> 'rejected' OR ("reason" IS NOT NULL AND "decided_by" IS NOT NULL)),
  ADD CONSTRAINT "seller_cultures_version_check" CHECK ("version" >= 1);

-- Grants (least privilege). A membership is never deleted; a request, a decision and a new request
-- after a rejection update only the columns they change.
GRANT SELECT, INSERT,
  UPDATE ("status", "reason", "requested_by", "requested_at", "decided_by", "decided_at", "version", "updated_at")
  ON TABLE "sellers"."seller_cultures" TO "mondapac_app";
