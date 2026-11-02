SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- CreateTable
CREATE TABLE "catalog"."attribute_relaxation_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" UUID NOT NULL,
    "definition_version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "family_id" UUID,
    "status" TEXT NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL,

    CONSTRAINT "attribute_relaxation_requests_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE INDEX "attribute_relaxation_requests_market_id_status_expires_at_idx" ON "catalog"."attribute_relaxation_requests"("market_id", "status", "expires_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_relaxation_requests_market_id_definition_id_id_key" ON "catalog"."attribute_relaxation_requests"("market_id", "definition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definition_revisions_market_id_relaxation_request_key" ON "catalog"."attribute_definition_revisions"("market_id", "relaxation_request_id");

-- AddForeignKey
ALTER TABLE "catalog"."attribute_relaxation_requests" ADD CONSTRAINT "attribute_relaxation_requests_market_id_definition_id_fkey" FOREIGN KEY ("market_id", "definition_id") REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_relaxation_requests" ADD CONSTRAINT "attribute_relaxation_requests_market_id_family_id_fkey" FOREIGN KEY ("market_id", "family_id") REFERENCES "catalog"."attribute_families"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): catalog data design 3.21 and the 3.5 M2 trigger for clearing
-- `material` (migration plan row 13, slice 21; attributes package A2 part 3). The archive and
-- remove-from-family halves of row 13 (`attribute_definitions.archived_by_request_id`, the
-- same-family FK from family revisions and their triggers) arrive with the use cases that archive
-- a published definition or edit a family's members; until then no unit can do either.

-- The revisions' same-definition FK (Hassan M2): a revision names only a request of its own
-- definition. The column has been NULL on every row so far, so VALIDATE scans nothing to refuse.
ALTER TABLE "catalog"."attribute_definition_revisions"
  ADD CONSTRAINT "attribute_definition_revisions_market_id_definition_id_rel_fkey"
  FOREIGN KEY ("market_id", "definition_id", "relaxation_request_id")
  REFERENCES "catalog"."attribute_relaxation_requests"("market_id", "definition_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "catalog"."attribute_definition_revisions"
  VALIDATE CONSTRAINT "attribute_definition_revisions_market_id_definition_id_rel_fkey";

ALTER TABLE "catalog"."attribute_relaxation_requests"
  ADD CONSTRAINT "attribute_relaxation_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_relaxation_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "attribute_relaxation_requests_definition_version_check" CHECK ("definition_version" > 0),
  ADD CONSTRAINT "attribute_relaxation_requests_kind_check" CHECK (
    "kind" IN ('clear-material', 'archive', 'remove-from-family')),
  ADD CONSTRAINT "attribute_relaxation_requests_family_check" CHECK (
    ("kind" = 'remove-from-family') = ("family_id" IS NOT NULL)),
  ADD CONSTRAINT "attribute_relaxation_requests_status_check" CHECK (
    "status" IN ('open', 'confirmed', 'cancelled', 'expired')),
  ADD CONSTRAINT "attribute_relaxation_requests_expires_at_check" CHECK (
    "expires_at" > "requested_at" AND "expires_at" <= "requested_at" + interval '168 hours'),
  ADD CONSTRAINT "attribute_relaxation_requests_cancel_reason_check" CHECK (
    ("cancel_reason" IS NULL OR "cancel_reason" IN ('requester', 'definition-changed'))
    AND ("status" = 'cancelled') = ("cancel_reason" IS NOT NULL)),
  ADD CONSTRAINT "attribute_relaxation_requests_version_check" CHECK ("version" >= 1),
  -- Hassan 2: the database backstop of the two-person rule.
  ADD CONSTRAINT "attribute_relaxation_requests_two_people_check" CHECK (
    "confirmed_by_account_id" IS NULL OR "confirmed_by_account_id" <> "requested_by_account_id"),
  ADD CONSTRAINT "attribute_relaxation_requests_confirmed_check" CHECK (
    ("status" = 'confirmed') = ("confirmed_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "attribute_relaxation_requests_closed_check" CHECK (
    ("status" = 'open') = ("closed_at" IS NULL)),
  ADD CONSTRAINT "attribute_relaxation_requests_confirm_in_time_check" CHECK (
    "status" <> 'confirmed' OR "closed_at" <= "expires_at");

-- At most one open request per definition.
CREATE UNIQUE INDEX "attribute_relaxation_requests_open_definition_key"
  ON "catalog"."attribute_relaxation_requests" ("market_id", "definition_id") WHERE "status" = 'open';

CREATE FUNCTION "catalog"."attribute_relaxation_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Mojtaba M1, Hassan M3: a request is born open, so a confirmed row only ever comes from a move.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.confirmed_by_account_id IS NOT NULL
       OR NEW.closed_at IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'catalog.attribute_relaxation_requests: a new request is open at version 1' USING ERRCODE = 'check_violation';
    END IF;
    -- Hassan Low-a: a request is not dated ahead, which would keep it open longer.
    IF NEW.requested_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.attribute_relaxation_requests: requested_at is in the future' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: a closed request never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.definition_id, NEW.definition_version, NEW.kind, NEW.family_id,
      NEW.requested_by_account_id, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.definition_id, OLD.definition_version, OLD.kind, OLD.family_id,
      OLD.requested_by_account_id, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'open' AND (NEW.closed_at < statement_timestamp() - interval '5 minutes'
                            OR NEW.closed_at > statement_timestamp() + interval '5 minutes') THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: closed_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "attribute_relaxation_requests_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."attribute_relaxation_requests"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_relaxation_requests_guard"();
CREATE TRIGGER "attribute_relaxation_requests_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_relaxation_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- 3.5 (Hassan M2). A published (not draft) definition whose current revision is `material` gets a
-- revision without it only with a confirmed clear-material request of the same definition, written
-- by the confirming admin; any other revision names no request. A draft was never shown to
-- sellers, so its flag is free; the status trigger below keeps a published definition from
-- turning back into a draft.
CREATE FUNCTION "catalog"."relaxation_confirmed"(p_market varchar, p_request uuid, p_definition uuid, p_kind text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "catalog"."attribute_relaxation_requests" r
    WHERE r.market_id = p_market AND r.id = p_request AND r.definition_id = p_definition
      AND r.kind = p_kind AND r.status = 'confirmed');
$$;
-- Not a trigger function, so PUBLIC does not execute it (platform 10.5 guard 1); the trigger runs
-- as the API role, which does.
REVOKE EXECUTE ON FUNCTION "catalog"."relaxation_confirmed"(varchar, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "catalog"."relaxation_confirmed"(varchar, uuid, uuid, text) TO "mondapac_app";
CREATE FUNCTION "catalog"."attribute_definition_revisions_relaxation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prev_material boolean;
BEGIN
  SELECT r.material INTO prev_material
    FROM "catalog"."attribute_definitions" d
    JOIN "catalog"."attribute_definition_revisions" r
      ON r.market_id = d.market_id AND r.id = d.published_revision_id
   WHERE d.market_id = NEW.market_id AND d.id = NEW.definition_id AND d.status <> 'draft';
  IF prev_material AND NOT NEW.material THEN
    IF NEW.relaxation_request_id IS NULL OR NOT "catalog"."relaxation_confirmed"(
         NEW.market_id, NEW.relaxation_request_id, NEW.definition_id, 'clear-material')
       -- Hassan M3: the revision is the confirming admin's own.
       OR NEW.author_account_id IS DISTINCT FROM (
         SELECT r.confirmed_by_account_id FROM "catalog"."attribute_relaxation_requests" r
          WHERE r.market_id = NEW.market_id AND r.id = NEW.relaxation_request_id) THEN
      RAISE EXCEPTION 'catalog.attribute_definition_revisions: clearing material needs a confirmed clear-material request'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.relaxation_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'catalog.attribute_definition_revisions: a relaxation request names only a material clearing'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "attribute_definition_revisions_relaxation" BEFORE INSERT
  ON "catalog"."attribute_definition_revisions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_definition_revisions_relaxation"();

-- Hassan M1, Mojtaba M2: the draft exception above holds only if a definition never goes back to
-- draft, and nothing comes back from archived. Moves the status CHECK already refuses are left to
-- it. Hassan M2: the published pointer only moves forward, to a revision numbered at least as high,
-- so no older revision without `material` can be pointed at again. A pointer at another
-- definition's revision is left to the foreign key.
CREATE FUNCTION "catalog"."attribute_definitions_guard"() RETURNS trigger LANGUAGE plpgsql
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
CREATE TRIGGER "attribute_definitions_guard" BEFORE UPDATE OF "status", "published_revision_id"
  ON "catalog"."attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_definitions_guard"();

-- Grants (data design 7): the status moves once; nothing else is updated and nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("status", "confirmed_by_account_id", "closed_at", "cancel_reason", "version")
  ON TABLE "catalog"."attribute_relaxation_requests" TO "mondapac_app";
