SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261104170000_catalog_attribute_archive: the guard function as it was before.
CREATE OR REPLACE FUNCTION "catalog"."attribute_definitions_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_no integer; new_no integer;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'draft' OR OLD.status = 'archived') THEN
    RAISE EXCEPTION 'catalog.attribute_definitions: % to % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
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
