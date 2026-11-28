-- Seller activity requests (BUG-012 step 2; ADR-0040 decision 4). The business activities a seller
-- asks for while setting up the account: one row per seller, replaced on each save. A request never
-- changes what the seller carries; the reviewer applies it with the admin change. The activity ids
-- are plain ids with no foreign key across schemas.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "sellers"."seller_activity_requests" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "main_activity_id" UUID NOT NULL,
    "extra_activity_ids" UUID[],
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_activity_requests_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- AddForeignKey
ALTER TABLE "sellers"."seller_activity_requests" ADD CONSTRAINT "seller_activity_requests_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs.
ALTER TABLE "sellers"."seller_activity_requests"
  ADD CONSTRAINT "seller_activity_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_activity_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_activity_requests_extras_check" CHECK (
    "extra_activity_ids" IS NOT NULL AND cardinality("extra_activity_ids") <= 9),
  ADD CONSTRAINT "seller_activity_requests_main_check" CHECK (
    NOT ("main_activity_id" = ANY ("extra_activity_ids")));

-- Grants (least privilege). A save replaces the row's values; the key is never updated.
GRANT SELECT, INSERT ON TABLE "sellers"."seller_activity_requests" TO "mondapac_app";
GRANT UPDATE ("main_activity_id", "extra_activity_ids", "requested_by", "requested_at")
  ON TABLE "sellers"."seller_activity_requests" TO "mondapac_app";
