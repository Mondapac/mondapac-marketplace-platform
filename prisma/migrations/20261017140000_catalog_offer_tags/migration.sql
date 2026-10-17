-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."offer_tags" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "basis" TEXT,
    "certificate_kind" TEXT,
    "certificate_id" UUID,
    "certificate_version_id" UUID,
    "issuer_id" UUID,
    "type_revision_id" UUID,
    "policy_revision_id" UUID,
    "valid_until" TIMESTAMPTZ(6),
    "badge_data" JSONB,
    "copy_revision_id" UUID,
    "copy_revision_published" BOOLEAN NOT NULL,
    "inputs_hash" BYTEA,
    "last_reason_code" TEXT,
    "last_change_cause" TEXT,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "change_seq" INTEGER NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by_kind" TEXT,
    "removed_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."offer_tag_history" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tag_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "basis" TEXT,
    "certificate_kind" TEXT,
    "certificate_id" UUID,
    "certificate_version_id" UUID,
    "issuer_id" UUID,
    "policy_revision_id" UUID,
    "copy_revision_id" UUID,
    "reason_code" TEXT,
    "entry_path" TEXT NOT NULL,
    "change_seq" INTEGER NOT NULL,
    "cause_event_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "acting_admin_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_tag_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offer_tags_market_id_id_key" ON "catalog"."offer_tags"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_tags_market_id_id_offer_id_type_code_key" ON "catalog"."offer_tags"("market_id", "id", "offer_id", "type_code");

-- CreateIndex
CREATE INDEX "offer_tag_history_market_id_offer_id_occurred_at_idx" ON "catalog"."offer_tag_history"("market_id", "offer_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "offer_tag_history_market_id_tag_id_change_seq_key" ON "catalog"."offer_tag_history"("market_id", "tag_id", "change_seq");

-- AddForeignKey
ALTER TABLE "catalog"."offer_tags" ADD CONSTRAINT "offer_tags_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."offer_tags" ADD CONSTRAINT "offer_tags_market_id_copy_revision_id_fkey" FOREIGN KEY ("market_id", "copy_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."offer_tag_history" ADD CONSTRAINT "offer_tag_history_market_id_tag_id_offer_id_type_code_fkey" FOREIGN KEY ("market_id", "tag_id", "offer_id", "type_code") REFERENCES "catalog"."offer_tags"("market_id", "id", "offer_id", "type_code") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: docs/design/data/catalog.md 3.15, 3.16, 5.1, 7 and 8.1 row 6 (migration 6 of
-- the plan, slice 8). Every constraint is on a new table. The selection indexes of 3.15 come in
-- slice 12 (migration 10); this one holds the open-tag partial unique, which is also the "tags of
-- these Offers" path the aggregate reads (A2, A7).
ALTER TABLE "catalog"."offer_tags"
  ADD CONSTRAINT "offer_tags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_tags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- CA4: a validated vocabulary code (D 19.2 item 10).
  ADD CONSTRAINT "offer_tags_type_code_check" CHECK ("type_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_tags_status_check" CHECK ("status" IN
    ('pending-publish', 'active', 'rechecking', 'suspended', 'removed')),
  ADD CONSTRAINT "offer_tags_basis_check" CHECK ("basis" IS NULL OR "basis" IN ('SELLER', 'MANUFACTURER')),
  ADD CONSTRAINT "offer_tags_certificate_kind_check" CHECK (
    "certificate_kind" IS NULL OR "certificate_kind" IN ('seller', 'manufacturer')),
  ADD CONSTRAINT "offer_tags_badge_data_object_check" CHECK (
    "badge_data" IS NULL OR jsonb_typeof("badge_data") = 'object'),
  -- D 5.3: no badge while pending-publish, rechecking, suspended or removed.
  ADD CONSTRAINT "offer_tags_badge_data_check" CHECK ("badge_data" IS NULL OR "status" = 'active'),
  -- An active row always holds a full copy; issuer and expiry may be NULL (Hassan L4).
  ADD CONSTRAINT "offer_tags_active_copy_check" CHECK ("status" <> 'active' OR (
    "basis" IS NOT NULL AND "certificate_kind" IS NOT NULL AND "certificate_id" IS NOT NULL
    AND "certificate_version_id" IS NOT NULL AND "type_revision_id" IS NOT NULL
    AND "copy_revision_id" IS NOT NULL AND "inputs_hash" IS NOT NULL AND "badge_data" IS NOT NULL)),
  -- Hassan M1: a live tag names a revision that was published at its decision.
  ADD CONSTRAINT "offer_tags_published_copy_check" CHECK (
    "status" IN ('pending-publish', 'removed') OR "copy_revision_published"),
  -- D 17.1 item 12a: a pending-publish tag names the frozen submitted revision, never a
  -- published one, so every selection index (predicate copy_revision_published) excludes it.
  ADD CONSTRAINT "offer_tags_pending_publish_check" CHECK ("status" <> 'pending-publish' OR (
    "copy_revision_id" IS NOT NULL AND NOT "copy_revision_published" AND "badge_data" IS NULL)),
  ADD CONSTRAINT "offer_tags_inputs_hash_check" CHECK (
    "inputs_hash" IS NULL OR octet_length("inputs_hash") = 32),
  ADD CONSTRAINT "offer_tags_last_reason_code_check" CHECK (
    "last_reason_code" IS NULL OR "last_reason_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_tags_last_change_cause_check" CHECK ("last_change_cause" IS NULL OR
    "last_change_cause" IN ('offer-create', 'offer-edit', 'handling-change', 'attestation-change',
      'tag-add', 'revision-submit', 'revision-publish', 'revision-revert', 'category-change',
      'match', 'promotion', 'offer-reactivated', 'tax-category-override', 'import-row',
      'certification-event', 'reconciliation', 'seller-remove', 'seller-remove-suspended',
      'offer-delete', 'product-withdrawn', 'product-retired')),
  ADD CONSTRAINT "offer_tags_change_seq_check" CHECK ("change_seq" >= 1),
  ADD CONSTRAINT "offer_tags_removed_check" CHECK (("status" = 'removed') = ("removed_at" IS NOT NULL)),
  -- A seller removal names the account; a system removal names none (Mojtaba F4).
  ADD CONSTRAINT "offer_tags_removed_by_check" CHECK (
    ("removed_at" IS NULL) = ("removed_by_kind" IS NULL)
    AND ("removed_by_kind" IS NULL OR "removed_by_kind" IN ('seller', 'system'))
    AND COALESCE("removed_by_kind" = 'seller', false) = ("removed_by_account_id" IS NOT NULL));

-- One tag that is not removed per (Offer, type) (D 17.1); also the read of an Offer's open tags.
-- Not CONCURRENTLY: the table is new and empty (8.2).
CREATE UNIQUE INDEX "offer_tags_market_id_offer_id_type_code_open_key"
  ON "catalog"."offer_tags" ("market_id", "offer_id", "type_code") WHERE "status" <> 'removed';

-- Hot table (3.15): the reconciliation rewrites evaluated_at daily and M1 rewrites status.
ALTER TABLE "catalog"."offer_tags" SET (
  autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

ALTER TABLE "catalog"."offer_tag_history"
  ADD CONSTRAINT "offer_tag_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_tag_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_tag_history_type_code_check" CHECK ("type_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_tag_history_from_status_check" CHECK ("from_status" IS NULL OR "from_status" IN
    ('pending-publish', 'active', 'rechecking', 'suspended', 'removed')),
  ADD CONSTRAINT "offer_tag_history_to_status_check" CHECK ("to_status" IN
    ('pending-publish', 'active', 'rechecking', 'suspended', 'removed')),
  ADD CONSTRAINT "offer_tag_history_basis_check" CHECK (
    "basis" IS NULL OR "basis" IN ('SELLER', 'MANUFACTURER')),
  ADD CONSTRAINT "offer_tag_history_certificate_kind_check" CHECK (
    "certificate_kind" IS NULL OR "certificate_kind" IN ('seller', 'manufacturer')),
  ADD CONSTRAINT "offer_tag_history_reason_code_check" CHECK (
    "reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_tag_history_entry_path_check" CHECK ("entry_path" IN ('offer-create',
    'offer-edit', 'handling-change', 'attestation-change', 'tag-add', 'revision-submit',
    'revision-publish', 'revision-revert', 'category-change', 'match', 'promotion',
    'offer-reactivated', 'tax-category-override', 'import-row', 'certification-event',
    'reconciliation', 'seller-remove', 'seller-remove-suspended', 'offer-delete',
    'product-withdrawn', 'product-retired')),
  ADD CONSTRAINT "offer_tag_history_change_seq_check" CHECK ("change_seq" >= 1),
  -- The first row of a tag (and only it) has no from-status (Mojtaba F4).
  ADD CONSTRAINT "offer_tag_history_first_row_check" CHECK (("from_status" IS NULL) = ("change_seq" = 1)),
  ADD CONSTRAINT "offer_tag_history_actor_kind_check" CHECK ("actor_kind" IN ('seller', 'admin', 'system')),
  ADD CONSTRAINT "offer_tag_history_actor_account_check" CHECK (
    ("actor_kind" = 'system') = ("actor_account_id" IS NULL)),
  ADD CONSTRAINT "offer_tag_history_acting_admin_check" CHECK (
    "acting_admin_account_id" IS NULL OR "actor_kind" = 'seller');

-- 3.15, 3.16 (Mojtaba F1, Hassan M4): change_seq is 1 at insert and raised by exactly one with
-- every change of the status or of the claim copy (basis, certificate, issuer, type revision,
-- policy revision, expiry, copy revision), unchanged otherwise (23514). Rules of 5.1: SECURITY
-- INVOKER, a fixed search_path, schema-qualified names, no dynamic EXECUTE.
CREATE FUNCTION "catalog"."offer_tags_change_seq"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.change_seq <> 1 THEN
      RAISE EXCEPTION 'catalog.offer_tags: change_seq starts at 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.status, NEW.basis, NEW.certificate_kind, NEW.certificate_id,
         NEW.certificate_version_id, NEW.issuer_id, NEW.type_revision_id, NEW.policy_revision_id,
         NEW.valid_until, NEW.copy_revision_id)
        IS DISTINCT FROM
        (OLD.status, OLD.basis, OLD.certificate_kind, OLD.certificate_id,
         OLD.certificate_version_id, OLD.issuer_id, OLD.type_revision_id, OLD.policy_revision_id,
         OLD.valid_until, OLD.copy_revision_id) THEN
    IF NEW.change_seq <> OLD.change_seq + 1 THEN
      RAISE EXCEPTION 'catalog.offer_tags: a status or copy change raises change_seq by one'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.change_seq <> OLD.change_seq THEN
    RAISE EXCEPTION 'catalog.offer_tags: change_seq changes only with the status or the copy'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_tags_change_seq" BEFORE INSERT OR UPDATE ON "catalog"."offer_tags"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_tags_change_seq"();

-- CA3 (5.1): the tag history is insert-only for every role, the owner included.
CREATE TRIGGER "offer_tag_history_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."offer_tag_history"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "offer_tag_history_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_tag_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- 3.15: every change of status or copy has its history row holding the new status and copy,
-- checked at commit (body of 5.1 with the copy columns, Mojtaba F1, Hassan M4).
CREATE FUNCTION "catalog"."offer_tags_history_present"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur record;
BEGIN
  SELECT t.status, t.change_seq, t.basis, t.certificate_kind, t.certificate_id,
         t.certificate_version_id, t.issuer_id, t.policy_revision_id, t.copy_revision_id
    INTO cur FROM "catalog"."offer_tags" t
   WHERE t.market_id = NEW.market_id AND t.id = NEW.id;
  IF cur.change_seq <> NEW.change_seq THEN RETURN NULL; END IF;  -- a later change in the unit checks itself
  IF NOT EXISTS (SELECT 1 FROM "catalog"."offer_tag_history" h
                  WHERE h.market_id = NEW.market_id AND h.tag_id = NEW.id
                    AND h.change_seq = cur.change_seq AND h.to_status = cur.status
                    AND h.basis IS NOT DISTINCT FROM cur.basis
                    AND h.certificate_kind IS NOT DISTINCT FROM cur.certificate_kind
                    AND h.certificate_id IS NOT DISTINCT FROM cur.certificate_id
                    AND h.certificate_version_id IS NOT DISTINCT FROM cur.certificate_version_id
                    AND h.issuer_id IS NOT DISTINCT FROM cur.issuer_id
                    AND h.policy_revision_id IS NOT DISTINCT FROM cur.policy_revision_id
                    AND h.copy_revision_id IS NOT DISTINCT FROM cur.copy_revision_id) THEN
    RAISE EXCEPTION 'catalog.offer_tags: status or copy change without its offer_tag_history row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "offer_tags_history_present"
  AFTER INSERT OR UPDATE OF "status", "basis", "certificate_kind", "certificate_id",
    "certificate_version_id", "issuer_id", "type_revision_id", "policy_revision_id",
    "valid_until", "copy_revision_id"
  ON "catalog"."offer_tags"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_tags_history_present"();

-- Grants (section 7): no DELETE; the identity columns (id, market, tenant, Offer, seller, type,
-- creation) are never updated. The history takes SELECT and INSERT only.
GRANT SELECT, INSERT, UPDATE ("status", "basis", "certificate_kind", "certificate_id",
  "certificate_version_id", "issuer_id", "type_revision_id", "policy_revision_id", "valid_until",
  "badge_data", "copy_revision_id", "copy_revision_published", "inputs_hash", "last_reason_code",
  "last_change_cause", "evaluated_at", "status_changed_at", "change_seq", "removed_at",
  "removed_by_kind", "removed_by_account_id")
  ON TABLE "catalog"."offer_tags" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."offer_tag_history" TO "mondapac_app";
