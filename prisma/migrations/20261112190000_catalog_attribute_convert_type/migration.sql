SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Hand-written (database-designer): attributes package A8, converting an attribute's type (plan
-- decision ت۵). Two paths only: integer to decimal and select to multi-select. A type changes on a
-- published, non-material attribute that is not a variant option and that nothing was merged into,
-- in the same statement that moves its published revision forward (the conversion is a revision).
-- Stored product values are not rewritten: every integer is a valid decimal and the readers take a
-- single value as a list of one.
CREATE OR REPLACE FUNCTION "catalog"."attribute_definitions_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_no integer; new_no integer; current_material boolean; target_type text; target_merged uuid; target_status text; current_variant boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'draft' OR OLD.status = 'archived') THEN
    RAISE EXCEPTION 'catalog.attribute_definitions: % to % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'archived' AND OLD.status = 'active' THEN
    -- Attributes merged into this one point at it: archiving it would hide their values.
    IF EXISTS (SELECT 1 FROM "catalog"."attribute_definitions" s
                WHERE s.market_id = OLD.market_id AND s.merged_into_id = OLD.id) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: an attribute that others were merged into cannot be archived'
        USING ERRCODE = 'restrict_violation';
    END IF;
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
  IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    IF OLD.merged_into_id IS NOT NULL OR NEW.merged_into_id IS NULL
       OR NEW.status <> 'archived' OR OLD.status <> 'active' THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: an attribute is merged once, when it is archived'
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT t.data_type, t.merged_into_id, t.status INTO target_type, target_merged, target_status
      FROM "catalog"."attribute_definitions" t
     WHERE t.market_id = NEW.market_id AND t.id = NEW.merged_into_id
       FOR SHARE;
    IF target_type IS DISTINCT FROM NEW.data_type OR target_merged IS NOT NULL OR target_status <> 'active' THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: a merge target is an active attribute of the same type that was not merged itself'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.data_type IS DISTINCT FROM OLD.data_type THEN
    IF NOT ((OLD.data_type = 'integer' AND NEW.data_type = 'decimal')
         OR (OLD.data_type = 'select' AND NEW.data_type = 'multi-select')) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: % to % is not a type change that is allowed', OLD.data_type, NEW.data_type
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'active' OR NEW.status <> 'active' OR OLD.merged_into_id IS NOT NULL
       OR NEW.published_revision_id IS NOT DISTINCT FROM OLD.published_revision_id THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: a type changes on a published attribute, with a new revision'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "catalog"."attribute_definitions" s
                WHERE s.market_id = OLD.market_id AND s.merged_into_id = OLD.id) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: an attribute that others were merged into keeps its type'
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Neither the revision it leaves nor the one it moves to is material or a variant option, and
    -- the new one is this definition's own, newest and later revision.
    SELECT bool_or(r.material), bool_or(r.is_variant_option) INTO current_material, current_variant
      FROM "catalog"."attribute_definition_revisions" r
     WHERE r.market_id = NEW.market_id AND r.definition_id = NEW.id
       AND r.id IN (OLD.published_revision_id, NEW.published_revision_id);
    IF current_material OR current_variant THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: a material attribute or a variant option keeps its type'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "catalog"."attribute_definition_revisions" n
                    JOIN "catalog"."attribute_definition_revisions" o
                      ON o.market_id = n.market_id AND o.definition_id = n.definition_id AND o.id = OLD.published_revision_id
                   WHERE n.market_id = NEW.market_id AND n.definition_id = NEW.id
                     AND n.id = NEW.published_revision_id
                     AND n.revision_no > o.revision_no
                     AND n.revision_no = (SELECT max(m.revision_no) FROM "catalog"."attribute_definition_revisions" m
                                           WHERE m.market_id = n.market_id AND m.definition_id = n.definition_id)) THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: a type changes with this attribute''s own newest revision'
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
CREATE TRIGGER "attribute_definitions_guard" BEFORE UPDATE OF "status", "published_revision_id", "merged_into_id", "data_type"
  ON "catalog"."attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_definitions_guard"();

-- Last, so the column is never writable without the guard that watches it.
GRANT UPDATE ("data_type") ON TABLE "catalog"."attribute_definitions" TO "mondapac_app";
