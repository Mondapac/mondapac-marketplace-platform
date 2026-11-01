-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "reviews"."product_reviews" ADD COLUMN     "helpful_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "reviews"."helpful_votes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "review_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "helpful_votes_pkey" PRIMARY KEY ("market_id","review_id","account_id")
);

-- CreateTable
CREATE TABLE "search"."product_ratings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "rating_count" INTEGER NOT NULL,
    "rating_sum" INTEGER NOT NULL,
    "bayes_times_1000" INTEGER NOT NULL,
    "boost_ppm" INTEGER NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_ratings_pkey" PRIMARY KEY ("market_id","product_id")
);

-- CreateIndex
CREATE INDEX "helpful_votes_market_id_account_id_created_at_idx" ON "reviews"."helpful_votes"("market_id", "account_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "reviews"."helpful_votes" ADD CONSTRAINT "helpful_votes_market_id_review_id_fkey" FOREIGN KEY ("market_id", "review_id") REFERENCES "reviews"."product_reviews"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs (the outer bounds of the data, whatever the application does).
ALTER TABLE "reviews"."product_reviews"
  ADD CONSTRAINT "product_reviews_helpful_count_check" CHECK ("helpful_count" >= 0);

ALTER TABLE "reviews"."helpful_votes"
  ADD CONSTRAINT "helpful_votes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "helpful_votes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "search"."product_ratings"
  ADD CONSTRAINT "product_ratings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_ratings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_ratings_count_check" CHECK ("rating_count" >= 1),
  ADD CONSTRAINT "product_ratings_sum_check" CHECK ("rating_sum" BETWEEN "rating_count" AND 5 * "rating_count"),
  ADD CONSTRAINT "product_ratings_bayes_check" CHECK ("bayes_times_1000" BETWEEN 0 AND 5000),
  -- The cap of the staged rating boost (owner decision N9) is a data rule: 10 % either way.
  ADD CONSTRAINT "product_ratings_boost_check" CHECK ("boost_ppm" BETWEEN 900000 AND 1100000);

-- Hand-written partial index (Prisma cannot declare it): the public list of one product in "most
-- helpful" order reads published rows only, by votes, then newest first.
CREATE INDEX "product_reviews_public_list_helpful_idx" ON "reviews"."product_reviews" ("market_id", "product_id", "helpful_count" DESC, "published_at" DESC, "id" DESC) WHERE "status" = 'published';

-- The count of votes on a review is kept exact by the database: an atomic +1 or -1 under the
-- review row's lock, in the same transaction as the vote, so parallel votes cannot lose one. The
-- application may write this column only through these triggers' effect (it is granted below for
-- the trigger, which runs as the invoker); a vote is never updated, only inserted or deleted.
CREATE FUNCTION "reviews"."keep_helpful_count"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "reviews"."product_reviews" SET "helpful_count" = "helpful_count" + 1
     WHERE "market_id" = NEW."market_id" AND "id" = NEW."review_id";
    RETURN NEW;
  END IF;
  UPDATE "reviews"."product_reviews" SET "helpful_count" = "helpful_count" - 1
   WHERE "market_id" = OLD."market_id" AND "id" = OLD."review_id";
  RETURN OLD;
END; $$;

CREATE TRIGGER "helpful_votes_keep_count" AFTER INSERT OR DELETE ON "reviews"."helpful_votes"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."keep_helpful_count"();
CREATE TRIGGER "helpful_votes_no_update" BEFORE UPDATE ON "reviews"."helpful_votes"
  FOR EACH ROW EXECUTE FUNCTION "reviews"."reject_mutation"();

-- Grants. A vote is inserted and deleted, never updated. The product list's search copy changes
-- only its numbers and is deleted when the product has no more published reviews.
GRANT SELECT, INSERT, DELETE ON TABLE "reviews"."helpful_votes" TO "mondapac_app";
GRANT UPDATE ("helpful_count") ON TABLE "reviews"."product_reviews" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("rating_count", "rating_sum", "bayes_times_1000", "boost_ppm", "synced_at"), DELETE ON TABLE "search"."product_ratings" TO "mondapac_app";
