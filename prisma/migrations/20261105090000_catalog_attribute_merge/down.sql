SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261105090000_catalog_attribute_merge. The merge pointers and option maps are lost; the
-- merged attributes stay archived.
CREATE OR REPLACE FUNCTION "catalog"."attribute_definitions_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_no integer; new_no integer; current_material boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'draft' OR OLD.status = 'archived') THEN
    RAISE EXCEPTION 'catalog.attribute_definitions: % to % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'archived' AND OLD.status = 'active' THEN
    SELECT r.material INTO current_material FROM "catalog"."attribute_definition_revisions" r
     WHERE r.market_id = OLD.market_id AND r.id = OLD.published_revision_id;
    IF current_material AND NOT EXISTS (
         SELECT 1 FROM "catalog"."attribute_relaxation_requests" q
          WHERE q.market_id = OLD.market_id AND q.definition_id = OLD.id AND q.kind = 'archive'
            AND q.status = 'confirmed' AND q.definition_version = OLD.version) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: archiving a material attribute needs a confirmed archive request'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.published_revision_id IS DISTINCT FROM OLD.published_revision_id
     AND OLD.published_revision_id IS NOT NULL THEN
    SELECT r.revision_no INTO old_no FROM "catalog"."attribute_definition_revisions" r
     WHERE r.market_id = OLD.market_id AND r.id = OLD.published_revision_id;
    SELECT r.revision_no INTO new_no FROM "catalog"."attribute_definition_revisions" r
     WHERE r.market_id = NEW.market_id AND r.definition_id = NEW.id AND r.id = NEW.published_revision_id;
    IF NEW.published_revision_id IS NULL OR (new_no IS NOT NULL AND new_no < old_no) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: the published revision only moves forward'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER "attribute_definitions_guard" ON "catalog"."attribute_definitions";
CREATE TRIGGER "attribute_definitions_guard" BEFORE UPDATE OF "status", "published_revision_id"
  ON "catalog"."attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_definitions_guard"();

DROP TRIGGER "attribute_merge_options_no_truncate" ON "catalog"."attribute_merge_options";
DROP TRIGGER "attribute_merge_options_no_update_delete" ON "catalog"."attribute_merge_options";
DROP TABLE "catalog"."attribute_merge_options";
DROP INDEX "catalog"."attribute_definitions_market_id_merged_into_id_idx";
ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_market_id_merged_into_id_fkey",
  DROP CONSTRAINT "attribute_definitions_merged_into_check";
REVOKE UPDATE ("merged_into_id") ON TABLE "catalog"."attribute_definitions" FROM "mondapac_app";
ALTER TABLE "catalog"."attribute_definitions" DROP COLUMN "merged_into_id";
