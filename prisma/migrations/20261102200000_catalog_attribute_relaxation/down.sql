SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261102200000_catalog_attribute_relaxation. The request rows are lost; a revision that
-- cleared `material` keeps its relaxation_request_id (revisions are insert-only), now pointing at
-- nothing, as the column was before this migration.
DROP TRIGGER "attribute_definitions_guard" ON "catalog"."attribute_definitions";
DROP FUNCTION "catalog"."attribute_definitions_guard"();
DROP TRIGGER "attribute_definition_revisions_relaxation" ON "catalog"."attribute_definition_revisions";
DROP FUNCTION "catalog"."attribute_definition_revisions_relaxation"();
DROP FUNCTION "catalog"."relaxation_confirmed"(varchar, uuid, uuid, text);

ALTER TABLE "catalog"."attribute_definition_revisions"
  DROP CONSTRAINT "attribute_definition_revisions_market_id_definition_id_rel_fkey";
DROP INDEX "catalog"."attribute_definition_revisions_market_id_relaxation_request_key";

DROP TRIGGER "attribute_relaxation_requests_no_truncate" ON "catalog"."attribute_relaxation_requests";
DROP TRIGGER "attribute_relaxation_requests_guard" ON "catalog"."attribute_relaxation_requests";
DROP FUNCTION "catalog"."attribute_relaxation_requests_guard"();
DROP TABLE "catalog"."attribute_relaxation_requests";
