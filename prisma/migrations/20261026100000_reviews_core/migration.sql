-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "reviews";

-- CreateTable
CREATE TABLE "reviews"."product_reviews" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID,
    "product_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "last_seller_order_id" UUID,
    "rating" SMALLINT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "locale" VARCHAR(35) NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "edited_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "last_purchase_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."seller_ratings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID,
    "seller_order_id" UUID,
    "seller_id" UUID NOT NULL,
    "satisfaction" SMALLINT NOT NULL,
    "as_described" BOOLEAN NOT NULL,
    "arrived_ok" BOOLEAN NOT NULL,
    "reason_code" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."review_replies" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "review_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "edited_at" TIMESTAMPTZ(6),

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."review_reports" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "review_id" UUID NOT NULL,
    "reporter_account_id" UUID,
    "reason_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."moderation_actions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "review_id" UUID NOT NULL,
    "actor_account_id" UUID,
    "action" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."review_signals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews"."rating_summaries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "count" INTEGER NOT NULL,
    "sum" INTEGER NOT NULL,
    "histogram_1" INTEGER NOT NULL,
    "histogram_2" INTEGER NOT NULL,
    "histogram_3" INTEGER NOT NULL,
    "histogram_4" INTEGER NOT NULL,
    "histogram_5" INTEGER NOT NULL,
    "rated_seller_orders" INTEGER NOT NULL,
    "satisfied_count" INTEGER NOT NULL,
    "as_described_yes" INTEGER NOT NULL,
    "arrived_ok_yes" INTEGER NOT NULL,
    "rebuilt_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rating_summaries_pkey" PRIMARY KEY ("market_id","subject_kind","subject_id")
);

-- CreateTable
CREATE TABLE "reviews"."market_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex

-- CreateIndex
CREATE INDEX "product_reviews_market_id_account_id_created_at_idx" ON "reviews"."product_reviews"("market_id", "account_id", "created_at" DESC);

-- CreateIndex

-- CreateIndex
CREATE UNIQUE INDEX "product_reviews_market_id_public_id_key" ON "reviews"."product_reviews"("market_id", "public_id");

CREATE UNIQUE INDEX "product_reviews_market_id_id_key" ON "reviews"."product_reviews"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_reviews_market_id_account_id_product_id_key" ON "reviews"."product_reviews"("market_id", "account_id", "product_id");

-- CreateIndex
CREATE INDEX "seller_ratings_market_id_seller_id_status_idx" ON "reviews"."seller_ratings"("market_id", "seller_id", "status");

-- CreateIndex
CREATE INDEX "seller_ratings_market_id_account_id_created_at_idx" ON "reviews"."seller_ratings"("market_id", "account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "seller_ratings_market_id_seller_order_id_key" ON "reviews"."seller_ratings"("market_id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_market_id_review_id_key" ON "reviews"."review_replies"("market_id", "review_id");

-- CreateIndex

-- CreateIndex
CREATE UNIQUE INDEX "review_reports_market_id_review_id_reporter_account_id_key" ON "reviews"."review_reports"("market_id", "review_id", "reporter_account_id");

-- CreateIndex
CREATE INDEX "moderation_actions_market_id_review_id_created_at_idx" ON "reviews"."moderation_actions"("market_id", "review_id", "created_at");

-- CreateIndex
CREATE INDEX "review_signals_market_id_subject_kind_subject_id_idx" ON "reviews"."review_signals"("market_id", "subject_kind", "subject_id");

-- AddForeignKey
ALTER TABLE "reviews"."review_replies" ADD CONSTRAINT "review_replies_market_id_review_id_fkey" FOREIGN KEY ("market_id", "review_id") REFERENCES "reviews"."product_reviews"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reviews"."review_reports" ADD CONSTRAINT "review_reports_market_id_review_id_fkey" FOREIGN KEY ("market_id", "review_id") REFERENCES "reviews"."product_reviews"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reviews"."moderation_actions" ADD CONSTRAINT "moderation_actions_market_id_review_id_fkey" FOREIGN KEY ("market_id", "review_id") REFERENCES "reviews"."product_reviews"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope, closed lists and ranges. The Market's own limits (title and body length,
-- the daily limit, the windows) are Market config and are enforced by the use cases; these
-- CHECKs are the outer bounds no Market config may exceed (market-config.ts `reviews`).
ALTER TABLE "reviews"."product_reviews"
  ADD CONSTRAINT "product_reviews_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_reviews_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "product_reviews_title_check" CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 200),
  ADD CONSTRAINT "product_reviews_body_check" CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 5000),
  ADD CONSTRAINT "product_reviews_locale_check" CHECK ("locale" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  ADD CONSTRAINT "product_reviews_status_check" CHECK ("status" IN ('published', 'held', 'hidden', 'removed', 'deleted-by-author')),
  ADD CONSTRAINT "product_reviews_published_at_check" CHECK (("status" = 'published') <= ("published_at" IS NOT NULL)),
  ADD CONSTRAINT "product_reviews_deleted_check" CHECK (("status" = 'deleted-by-author') = ("deleted_at" IS NOT NULL)),
  ADD CONSTRAINT "product_reviews_edited_at_check" CHECK ("edited_at" IS NULL OR "edited_at" >= "created_at"),
  ADD CONSTRAINT "product_reviews_deleted_at_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at"),
  ADD CONSTRAINT "product_reviews_order_link_check" CHECK ("account_id" IS NULL OR "last_seller_order_id" IS NOT NULL),
  ADD CONSTRAINT "product_reviews_deleted_text_check" CHECK ("status" <> 'deleted-by-author' OR ("title" IS NULL AND "body" IS NULL));

ALTER TABLE "reviews"."seller_ratings"
  ADD CONSTRAINT "seller_ratings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_ratings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_ratings_order_link_check" CHECK ("account_id" IS NULL OR "seller_order_id" IS NOT NULL),
  ADD CONSTRAINT "seller_ratings_satisfaction_check" CHECK ("satisfaction" BETWEEN 1 AND 5),
  ADD CONSTRAINT "seller_ratings_reason_check" CHECK ("reason_code" IS NULL OR ("arrived_ok" = false AND "reason_code" IN ('damaged', 'missing-items', 'temperature', 'other'))),
  ADD CONSTRAINT "seller_ratings_status_check" CHECK ("status" IN ('published', 'hidden', 'removed'));

ALTER TABLE "reviews"."review_replies"
  ADD CONSTRAINT "review_replies_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "review_replies_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "review_replies_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "review_replies_status_check" CHECK ("status" IN ('published', 'hidden', 'removed'));

ALTER TABLE "reviews"."review_reports"
  ADD CONSTRAINT "review_reports_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "review_reports_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "review_reports_reason_check" CHECK ("reason_code" ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD CONSTRAINT "review_reports_status_check" CHECK ("status" IN ('open', 'dismissed', 'actioned'));

ALTER TABLE "reviews"."moderation_actions"
  ADD CONSTRAINT "moderation_actions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "moderation_actions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "moderation_actions_action_check" CHECK ("action" IN ('auto-hold', 'publish', 'hold', 'hide', 'remove', 'restore', 'author-delete', 'author-edit')),
  ADD CONSTRAINT "moderation_actions_reason_check" CHECK ("reason_code" ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD CONSTRAINT "moderation_actions_from_status_check" CHECK ("from_status" IS NULL OR "from_status" IN ('published', 'held', 'hidden', 'removed', 'deleted-by-author')),
  ADD CONSTRAINT "moderation_actions_to_status_check" CHECK ("to_status" IN ('published', 'held', 'hidden', 'removed', 'deleted-by-author'));

ALTER TABLE "reviews"."review_signals"
  ADD CONSTRAINT "review_signals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "review_signals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "review_signals_subject_kind_check" CHECK ("subject_kind" IN ('product-review', 'seller-rating')),
  ADD CONSTRAINT "review_signals_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,39}$');

-- A summary is a count of ratings: the histogram adds up to the count, the sum fits the stars,
-- and the seller-only columns are zero on a product row and bounded by the count on a seller row.
ALTER TABLE "reviews"."rating_summaries"
  ADD CONSTRAINT "rating_summaries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "rating_summaries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "rating_summaries_subject_kind_check" CHECK ("subject_kind" IN ('product', 'seller')),
  ADD CONSTRAINT "rating_summaries_counts_check" CHECK (
    "count" >= 0 AND "histogram_1" >= 0 AND "histogram_2" >= 0 AND "histogram_3" >= 0
    AND "histogram_4" >= 0 AND "histogram_5" >= 0
    AND "histogram_1" + "histogram_2" + "histogram_3" + "histogram_4" + "histogram_5" = "count"
    AND "sum" = "histogram_1" + 2 * "histogram_2" + 3 * "histogram_3" + 4 * "histogram_4" + 5 * "histogram_5"),
  ADD CONSTRAINT "rating_summaries_seller_columns_check" CHECK (
    CASE "subject_kind"
      WHEN 'product' THEN "rated_seller_orders" = 0 AND "satisfied_count" = 0 AND "as_described_yes" = 0 AND "arrived_ok_yes" = 0
      ELSE "rated_seller_orders" = "count"
        AND "satisfied_count" BETWEEN 0 AND "count"
        AND "as_described_yes" BETWEEN 0 AND "count"
        AND "arrived_ok_yes" BETWEEN 0 AND "count"
        AND "satisfied_count" = "histogram_4" + "histogram_5"
    END);

ALTER TABLE "reviews"."market_settings"
  ADD CONSTRAINT "market_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "market_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "market_settings_status_check" CHECK ("status" IN ('off', 'active'));

-- Hand-written: insert-only and never-deleted tables. The moderation log and the signals are
-- never changed or removed, whoever asks. A review, a rating, a reply, a report, a summary and
-- the switch change only the columns granted below and are never deleted or truncated (an author
-- "deletes" a review by status; a summary is rebuilt to zero, not dropped).
-- Hand-written partial indexes (Prisma cannot declare them). The public list of one product reads
-- published rows only, newest first, with or without a star filter; the second index also serves
-- the summary job's group by (product, rating).
CREATE INDEX "product_reviews_public_list_idx" ON "reviews"."product_reviews" ("market_id", "product_id", "published_at" DESC, "id" DESC) WHERE "status" = 'published';
CREATE INDEX "product_reviews_public_list_rating_idx" ON "reviews"."product_reviews" ("market_id", "product_id", "rating", "published_at" DESC, "id" DESC) WHERE "status" = 'published';

CREATE FUNCTION "reviews"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'reviews.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "moderation_actions_no_update" BEFORE UPDATE ON "reviews"."moderation_actions"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "moderation_actions_no_delete" BEFORE DELETE ON "reviews"."moderation_actions"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "moderation_actions_no_truncate" BEFORE TRUNCATE ON "reviews"."moderation_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_signals_no_update" BEFORE UPDATE ON "reviews"."review_signals"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_signals_no_delete" BEFORE DELETE ON "reviews"."review_signals"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_signals_no_truncate" BEFORE TRUNCATE ON "reviews"."review_signals"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "product_reviews_no_delete" BEFORE DELETE ON "reviews"."product_reviews"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "product_reviews_no_truncate" BEFORE TRUNCATE ON "reviews"."product_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "seller_ratings_no_delete" BEFORE DELETE ON "reviews"."seller_ratings"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "seller_ratings_no_truncate" BEFORE TRUNCATE ON "reviews"."seller_ratings"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_replies_no_delete" BEFORE DELETE ON "reviews"."review_replies"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_replies_no_truncate" BEFORE TRUNCATE ON "reviews"."review_replies"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_reports_no_delete" BEFORE DELETE ON "reviews"."review_reports"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "review_reports_no_truncate" BEFORE TRUNCATE ON "reviews"."review_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "rating_summaries_no_delete" BEFORE DELETE ON "reviews"."rating_summaries"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "rating_summaries_no_truncate" BEFORE TRUNCATE ON "reviews"."rating_summaries"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "market_settings_no_delete" BEFORE DELETE ON "reviews"."market_settings"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();
CREATE TRIGGER "market_settings_no_truncate" BEFORE TRUNCATE ON "reviews"."market_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "reviews"."reject_mutation"();

-- Grants. The moderation log and the signals are read and appended to only; every other table
-- changes only the columns named (the identity and the scope of a row never change). Nothing is
-- deleted.
GRANT USAGE ON SCHEMA "reviews" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "reviews"."moderation_actions" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "reviews"."review_signals" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("account_id", "anonymous", "body", "created_at", "deleted_at", "edited_at", "last_purchase_at", "last_seller_order_id", "locale", "offer_id", "published_at", "rating", "seller_id", "status", "title") ON TABLE "reviews"."product_reviews" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("account_id", "seller_order_id", "status") ON TABLE "reviews"."seller_ratings" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("body", "edited_at", "status") ON TABLE "reviews"."review_replies" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status") ON TABLE "reviews"."review_reports" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("arrived_ok_yes", "as_described_yes", "count", "histogram_1", "histogram_2", "histogram_3", "histogram_4", "histogram_5", "rated_seller_orders", "rebuilt_at", "satisfied_count", "sum") ON TABLE "reviews"."rating_summaries" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "updated_at", "updated_by_account_id") ON TABLE "reviews"."market_settings" TO "mondapac_app";
