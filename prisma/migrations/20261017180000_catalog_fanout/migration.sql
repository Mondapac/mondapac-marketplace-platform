-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "catalog"."offer_tag_history" ADD COLUMN     "type_revision_id" UUID,
ADD COLUMN     "valid_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "catalog"."tag_reevaluation_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "product_id" UUID,
    "product_revision_id" UUID,
    "source_event_id" UUID,
    "state" TEXT NOT NULL,
    "cursor_offer_id" UUID,
    "counts" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "tag_reevaluation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tag_reevaluation_requests_market_id_id_key" ON "catalog"."tag_reevaluation_requests"("market_id", "id");

-- AddForeignKey
ALTER TABLE "catalog"."tag_reevaluation_requests" ADD CONSTRAINT "tag_reevaluation_requests_market_id_product_id_product_rev_fkey" FOREIGN KEY ("market_id", "product_id", "product_revision_id") REFERENCES "catalog"."product_revisions"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: docs/design/data/catalog.md 3.16, 3.18, 7 and 8.1 row 9 (migration 9 of the plan,
-- slice 11 `catalog_fanout`), plus two follow-ups of slice 8 on the same tables.

-- 3.18: the work items of the tag re-ask fan-out (D 5.4, 5.5). A new, empty table.
ALTER TABLE "catalog"."tag_reevaluation_requests"
  ADD CONSTRAINT "tag_reevaluation_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "tag_reevaluation_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "tag_reevaluation_requests_kind_check" CHECK ("kind" IN
    ('revision-published', 'category-changed', 'certification-event', 'types-reallowed')),
  -- A publish request names its product and revision; no other kind does.
  ADD CONSTRAINT "tag_reevaluation_requests_product_check" CHECK (
    ("kind" = 'revision-published') = ("product_id" IS NOT NULL)
    AND ("product_id" IS NULL) = ("product_revision_id" IS NULL)),
  -- A publish request comes from a unit, never from an event; every other kind from an event.
  ADD CONSTRAINT "tag_reevaluation_requests_source_check" CHECK (
    ("kind" = 'revision-published') = ("source_event_id" IS NULL)),
  ADD CONSTRAINT "tag_reevaluation_requests_state_check" CHECK ("state" IN
    ('pending', 'settled', 'superseded')),
  ADD CONSTRAINT "tag_reevaluation_requests_settled_check" CHECK (
    ("state" = 'pending') = ("settled_at" IS NULL)),
  ADD CONSTRAINT "tag_reevaluation_requests_counts_check" CHECK (jsonb_typeof("counts") = 'object');

-- One pending request per product: a newer publish supersedes the older one in its unit (update,
-- then insert). Not CONCURRENTLY: the table is new and empty (8.2).
CREATE UNIQUE INDEX "tag_reevaluation_requests_market_id_product_id_pending_key"
  ON "catalog"."tag_reevaluation_requests" ("market_id", "product_id")
  WHERE "state" = 'pending' AND "kind" = 'revision-published';
-- A request for a revision is written once (idempotent publish).
CREATE UNIQUE INDEX "tag_reevaluation_requests_market_id_product_revision_id_key"
  ON "catalog"."tag_reevaluation_requests" ("market_id", "product_revision_id")
  WHERE "kind" = 'revision-published';
-- One request per consumed event.
CREATE UNIQUE INDEX "tag_reevaluation_requests_market_id_source_event_id_key"
  ON "catalog"."tag_reevaluation_requests" ("market_id", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;
-- The job's claim order: pending requests, oldest first.
CREATE INDEX "tag_reevaluation_requests_market_id_created_at_pending_idx"
  ON "catalog"."tag_reevaluation_requests" ("market_id", "created_at", "id")
  WHERE "state" = 'pending';

-- Grants (section 7): no DELETE until the purge of 10.3 lands.
GRANT SELECT, INSERT, UPDATE ("state", "cursor_offer_id", "counts", "settled_at")
  ON TABLE "catalog"."tag_reevaluation_requests" TO "mondapac_app";

-- 3.16 (slice 8 follow-up, Mojtaba): the history keeps the copy's type revision and expiry. Both
-- nullable, no default: a catalog-only change, no rewrite. Rows recorded before this migration
-- keep NULL (the history is insert-only); the presence check of 3.15 is unchanged.

-- D 5.4 (slice 11): the Offer approval is an entry path of its own (`offer-approve`). Both lists
-- are replaced NOT VALID, then validated. Note (Mojtaba F2): the migration runs in one
-- transaction, so the VALIDATE does not avoid blocking here; the DROP/ADD already holds an ACCESS
-- EXCLUSIVE lock to commit, bounded by lock_timeout above, and both tables are small at this stage.
ALTER TABLE "catalog"."offer_tags" DROP CONSTRAINT "offer_tags_last_change_cause_check";
ALTER TABLE "catalog"."offer_tags" ADD CONSTRAINT "offer_tags_last_change_cause_check" CHECK (
  "last_change_cause" IS NULL OR "last_change_cause" IN ('offer-create', 'offer-edit',
    'handling-change', 'attestation-change', 'tag-add', 'revision-submit', 'revision-publish',
    'revision-revert', 'offer-approve', 'category-change', 'match', 'promotion',
    'offer-reactivated', 'tax-category-override', 'import-row', 'certification-event',
    'reconciliation', 'seller-remove', 'seller-remove-suspended', 'offer-delete',
    'product-withdrawn', 'product-retired')) NOT VALID;
ALTER TABLE "catalog"."offer_tags" VALIDATE CONSTRAINT "offer_tags_last_change_cause_check";
ALTER TABLE "catalog"."offer_tag_history" DROP CONSTRAINT "offer_tag_history_entry_path_check";
ALTER TABLE "catalog"."offer_tag_history" ADD CONSTRAINT "offer_tag_history_entry_path_check" CHECK (
  "entry_path" IN ('offer-create', 'offer-edit', 'handling-change', 'attestation-change',
    'tag-add', 'revision-submit', 'revision-publish', 'revision-revert', 'offer-approve',
    'category-change', 'match', 'promotion', 'offer-reactivated', 'tax-category-override',
    'import-row', 'certification-event', 'reconciliation', 'seller-remove',
    'seller-remove-suspended', 'offer-delete', 'product-withdrawn', 'product-retired')) NOT VALID;
ALTER TABLE "catalog"."offer_tag_history" VALIDATE CONSTRAINT "offer_tag_history_entry_path_check";
