-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health (package 3): a seller's daily counters and the daily snapshot of the score.
-- Both are new and empty, so there is no backfill; the first nightly rollup fills them.

-- CreateTable
CREATE TABLE "sellers"."seller_health_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "paid_orders" INTEGER NOT NULL,
    "ready_orders" INTEGER NOT NULL,
    "late_ready_orders" INTEGER NOT NULL,
    "lost_disputes" INTEGER NOT NULL,
    "reviews_approved" INTEGER NOT NULL,
    "rating_stars_sum" INTEGER NOT NULL,
    "recounted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_health_days_pkey" PRIMARY KEY ("market_id","seller_id","day")
);

-- CreateTable
CREATE TABLE "sellers"."seller_health_snapshots" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "band" TEXT,
    "score" INTEGER,
    "lowest_metric" TEXT,
    "formula_version" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_health_snapshots_pkey" PRIMARY KEY ("market_id","seller_id","day")
);

-- CreateIndex
CREATE INDEX "seller_health_snapshots_market_id_day_score_idx" ON "sellers"."seller_health_snapshots"("market_id", "day", "score");

-- AddForeignKey
ALTER TABLE "sellers"."seller_health_days" ADD CONSTRAINT "seller_health_days_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."seller_health_snapshots" ADD CONSTRAINT "seller_health_snapshots_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: counts are never negative; a late order is also a ready order; a review is 1 to 5
-- stars; a snapshot is scored exactly when it has a band, a score and a lowest metric.
ALTER TABLE "sellers"."seller_health_days"
  ADD CONSTRAINT "seller_health_days_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_health_days_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_health_days_counts_check" CHECK ("paid_orders" >= 0 AND "ready_orders" >= 0
    AND "late_ready_orders" >= 0 AND "lost_disputes" >= 0 AND "reviews_approved" >= 0
    AND "rating_stars_sum" >= 0),
  ADD CONSTRAINT "seller_health_days_late_check" CHECK ("late_ready_orders" <= "ready_orders"),
  ADD CONSTRAINT "seller_health_days_stars_check" CHECK ("rating_stars_sum" BETWEEN "reviews_approved" AND 5 * "reviews_approved");

ALTER TABLE "sellers"."seller_health_snapshots"
  ADD CONSTRAINT "seller_health_snapshots_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_health_snapshots_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_health_snapshots_kind_check" CHECK ("kind" IN ('scored', 'new', 'no-data')),
  ADD CONSTRAINT "seller_health_snapshots_band_check" CHECK ("band" IS NULL OR "band" IN ('healthy', 'at-risk', 'unhealthy')),
  ADD CONSTRAINT "seller_health_snapshots_score_check" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "seller_health_snapshots_metric_check" CHECK ("lowest_metric" IS NULL OR "lowest_metric" IN
    ('seller-cancellations', 'late-ready', 'customer-rating', 'lost-disputes', 'reports')),
  ADD CONSTRAINT "seller_health_snapshots_scored_check" CHECK (("kind" = 'scored')
    = ("band" IS NOT NULL AND "score" IS NOT NULL AND "lowest_metric" IS NOT NULL)
    AND ("kind" = 'scored' OR ("band" IS NULL AND "score" IS NULL AND "lowest_metric" IS NULL))),
  ADD CONSTRAINT "seller_health_snapshots_formula_check" CHECK (char_length("formula_version") BETWEEN 1 AND 16);

-- Grants. A day's counters and snapshot are set by the rollup and replaced by a recalculation, so
-- they can be updated; neither is ever deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_health_days" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_health_snapshots" TO "mondapac_app";
