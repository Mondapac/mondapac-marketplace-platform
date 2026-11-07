-- Topics on the product revision (product tags package T2). Creates catalog.product_revision_topics
-- (insert-only, like product_revision_categories) and adds the review reason `topics-changed`.
-- Nothing is backfilled: every stored revision has no topics. Safety: a blocked statement fails
-- instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."product_revision_topics" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "product_revision_topics_pkey" PRIMARY KEY ("market_id","revision_id","topic_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_topics_market_id_revision_id_position_key" ON "catalog"."product_revision_topics"("market_id", "revision_id", "position");

-- CreateIndex
CREATE INDEX "product_revision_topics_market_id_topic_id_revision_id_idx" ON "catalog"."product_revision_topics"("market_id", "topic_id", "revision_id");

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_topics" ADD CONSTRAINT "product_revision_topics_market_id_revision_id_fkey" FOREIGN KEY ("market_id", "revision_id") REFERENCES "catalog"."product_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."product_revision_topics" ADD CONSTRAINT "product_revision_topics_market_id_topic_id_fkey" FOREIGN KEY ("market_id", "topic_id") REFERENCES "catalog"."topics"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: CHECKs. At most 10 topics a product: positions 0 to 9, unique per revision.
ALTER TABLE "catalog"."product_revision_topics"
  ADD CONSTRAINT "product_revision_topics_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "product_revision_topics_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "product_revision_topics_position_check" CHECK ("position" BETWEEN 0 AND 9);

-- Insert-only: no update, delete or truncate (the same function as the other revision tables).
CREATE TRIGGER "product_revision_topics_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."product_revision_topics"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "product_revision_topics_no_truncate" BEFORE TRUNCATE
  ON "catalog"."product_revision_topics"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- A change of the topic set joins the review reasons (decision 3 of the tags design).
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'gtin-changed', 'topics-changed', 'never-published', 'approval-required']::text[])
  NOT VALID;
-- NOT VALID + VALIDATE only keeps the house pattern: the DROP above already holds the table's
-- ACCESS EXCLUSIVE lock until commit, and the widened list cannot fail on existing rows.
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_sensitive_reasons_check";

-- Grants (database-designer): a revision's topics are written once and read.
GRANT SELECT, INSERT ON TABLE "catalog"."product_revision_topics" TO "mondapac_app";
