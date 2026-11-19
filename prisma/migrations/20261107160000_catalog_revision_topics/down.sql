-- Reverses 20261107160000_catalog_revision_topics. A revision that carries the reason
-- `topics-changed` keeps its other reasons (and its `sensitive` flag); the topic rows are dropped
-- with their table.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "catalog"."product_revisions" DISABLE TRIGGER USER;
UPDATE "catalog"."product_revisions"
   SET "sensitive_reasons" = array_remove("sensitive_reasons", 'topics-changed')
 WHERE 'topics-changed' = ANY("sensitive_reasons");
ALTER TABLE "catalog"."product_revisions" ENABLE TRIGGER USER;
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'gtin-changed', 'never-published', 'approval-required']::text[]);

DROP TABLE "catalog"."product_revision_topics";
