-- Seller business activities (ADR-0040 decision 4; package 4a). A seller carries one MAIN activity and
-- up to nine extras. The activities are owned by catalog: activity_id is a plain id with no foreign key
-- across schemas. Nothing is backfilled: a seller with no activity is allowed to exist.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "sellers"."seller_business_activities" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "is_main" BOOLEAN NOT NULL,
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_business_activities_pkey" PRIMARY KEY ("market_id","seller_id","activity_id")
);

-- CreateTable
CREATE TABLE "sellers"."seller_business_activity_changes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "before_main_id" UUID,
    "before_extra_ids" UUID[],
    "after_main_id" UUID NOT NULL,
    "after_extra_ids" UUID[],

    CONSTRAINT "seller_business_activity_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_business_activities_market_id_activity_id_idx" ON "sellers"."seller_business_activities"("market_id", "activity_id");

-- CreateIndex
CREATE INDEX "seller_business_activity_changes_seller_idx" ON "sellers"."seller_business_activity_changes"("market_id", "seller_id", "changed_at", "id");

-- AddForeignKey
ALTER TABLE "sellers"."seller_business_activities" ADD CONSTRAINT "seller_business_activities_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."seller_business_activity_changes" ADD CONSTRAINT "seller_business_activity_changes_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs.
ALTER TABLE "sellers"."seller_business_activities"
  ADD CONSTRAINT "seller_business_activities_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_business_activities_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');
ALTER TABLE "sellers"."seller_business_activity_changes"
  ADD CONSTRAINT "seller_business_activity_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_business_activity_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_business_activity_changes_reason_check" CHECK (
    "reason" = btrim("reason") AND length("reason") BETWEEN 1 AND 300),
  ADD CONSTRAINT "seller_business_activity_changes_before_extras_check" CHECK (
    "before_extra_ids" IS NOT NULL AND cardinality("before_extra_ids") <= 9),
  ADD CONSTRAINT "seller_business_activity_changes_after_extras_check" CHECK (
    "after_extra_ids" IS NOT NULL AND cardinality("after_extra_ids") <= 9),
  ADD CONSTRAINT "seller_business_activity_changes_after_main_check" CHECK (
    NOT ("after_main_id" = ANY ("after_extra_ids"))),
  ADD CONSTRAINT "seller_business_activity_changes_before_main_check" CHECK (
    "before_main_id" IS NULL OR NOT ("before_main_id" = ANY ("before_extra_ids")));

-- At most one MAIN activity per seller in a Market. The "one main, at most nine extras" shape of the
-- whole set is the use case's invariant, written in one unit; the index is the database's backstop.
CREATE UNIQUE INDEX "seller_business_activities_one_main_key"
  ON "sellers"."seller_business_activities" ("market_id", "seller_id") WHERE "is_main";

-- Grants (least privilege). The set is replaced as a whole (DELETE then INSERT); a row is never
-- updated. The change log is insert-only.
GRANT SELECT, INSERT, DELETE ON TABLE "sellers"."seller_business_activities" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "sellers"."seller_business_activity_changes" TO "mondapac_app";
