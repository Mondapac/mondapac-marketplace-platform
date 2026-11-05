SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Hand-written (database-designer): attributes package A8, merging two attributes (plan decision
-- ت۶). The source is archived and points at its target; the pointer is set once, with the archive,
-- and the target is an active attribute of the same type that was not merged itself, so a chain is
-- one step. Where a source's option goes is kept in `attribute_merge_options` (insert-only).
ALTER TABLE "catalog"."attribute_definitions" ADD COLUMN "merged_into_id" UUID;
ALTER TABLE "catalog"."attribute_definitions"
  ADD CONSTRAINT "attribute_definitions_merged_into_check" CHECK (
    "merged_into_id" IS NULL OR ("status" = 'archived' AND "merged_into_id" <> "id")),
  ADD CONSTRAINT "attribute_definitions_market_id_merged_into_id_fkey" FOREIGN KEY ("market_id", "merged_into_id")
    REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "attribute_definitions_market_id_merged_into_id_idx"
  ON "catalog"."attribute_definitions"("market_id", "merged_into_id") WHERE "merged_into_id" IS NOT NULL;

CREATE TABLE "catalog"."attribute_merge_options" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "source_code" TEXT NOT NULL,
    "target_code" TEXT NOT NULL,
    CONSTRAINT "attribute_merge_options_pkey" PRIMARY KEY ("market_id","source_id","source_code"),
    CONSTRAINT "attribute_merge_options_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
    CONSTRAINT "attribute_merge_options_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT "attribute_merge_options_codes_check" CHECK (length("source_code") BETWEEN 1 AND 64 AND length("target_code") BETWEEN 1 AND 64)
);
ALTER TABLE "catalog"."attribute_merge_options" ADD CONSTRAINT "attribute_merge_options_market_id_source_id_fkey"
  FOREIGN KEY ("market_id", "source_id") REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER "attribute_merge_options_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."attribute_merge_options" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "attribute_merge_options_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_merge_options" FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
GRANT SELECT, INSERT ON TABLE "catalog"."attribute_merge_options" TO "mondapac_app";
GRANT UPDATE ("merged_into_id") ON TABLE "catalog"."attribute_definitions" TO "mondapac_app";

-- The guard function of the archive migration, with the merge block added.
CREATE OR REPLACE FUNCTION "catalog"."attribute_definitions_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_no integer; new_no integer; current_material boolean; target_type text; target_merged uuid; target_status text;
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
  IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    IF OLD.merged_into_id IS NOT NULL OR NEW.merged_into_id IS NULL
       OR NEW.status <> 'archived' OR OLD.status <> 'active' THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: an attribute is merged once, when it is archived'
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT t.data_type, t.merged_into_id, t.status INTO target_type, target_merged, target_status
      FROM "catalog"."attribute_definitions" t
     WHERE t.market_id = NEW.market_id AND t.id = NEW.merged_into_id;
    IF target_type IS DISTINCT FROM NEW.data_type OR target_merged IS NOT NULL OR target_status <> 'active' THEN
      RAISE EXCEPTION 'catalog.attribute_definitions: a merge target is an active attribute of the same type that was not merged itself'
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

-- The trigger also fires on the pointer, so it cannot be moved or cleared on its own.
DROP TRIGGER "attribute_definitions_guard" ON "catalog"."attribute_definitions";
CREATE TRIGGER "attribute_definitions_guard" BEFORE UPDATE OF "status", "published_revision_id", "merged_into_id"
  ON "catalog"."attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_definitions_guard"();
