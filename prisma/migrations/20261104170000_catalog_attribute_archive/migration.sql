SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Hand-written (database-designer): attributes package A8. The archive half of migration row 13
-- (catalog data design 3.5, 3.21): a published definition whose current revision is `material`
-- is archived only with a confirmed `archive` request of the same definition, made at the version
-- the archive starts from (the confirm unit locks the definition at that version). The request is
-- used once because an archived definition never changes status again (the guard below). Any other
-- definition, and a draft that is discarded, is archived without a request.
-- This replaces the guard function; the trigger on `status` and `published_revision_id` stays.
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
