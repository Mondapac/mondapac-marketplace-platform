-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."offers" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_sku" TEXT COLLATE "C" NOT NULL,
    "condition_code" TEXT NOT NULL,
    "description" JSONB NOT NULL,
    "handling" TEXT,
    "attestation_recorded_at" TIMESTAMPTZ(6),
    "attestation_account_id" UUID,
    "status" TEXT NOT NULL,
    "off_sale_type_not_allowed" BOOLEAN NOT NULL,
    "off_sale_product_retired" BOOLEAN NOT NULL,
    "off_sale_product_not_listed" BOOLEAN NOT NULL,
    "off_sale_tag_suspended" BOOLEAN NOT NULL,
    "off_sale_description_claim_text" BOOLEAN NOT NULL,
    "listed" BOOLEAN NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "first_published_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."offer_history" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "offer_version" INTEGER NOT NULL,
    "change_kind" TEXT NOT NULL,
    "changed_fields" TEXT[],
    "product_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "seller_sku" TEXT COLLATE "C" NOT NULL,
    "condition_code" TEXT NOT NULL,
    "description" JSONB NOT NULL,
    "handling" TEXT,
    "attestation_recorded" BOOLEAN NOT NULL,
    "shelf_category_id" UUID,
    "listed" BOOLEAN NOT NULL,
    "off_sale_causes" TEXT[],
    "actor_kind" TEXT NOT NULL,
    "actor_account_id" UUID,
    "acting_admin_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offers_market_id_id_key" ON "catalog"."offers"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_market_id_id_seller_id_key" ON "catalog"."offers"("market_id", "id", "seller_id");

-- CreateIndex
CREATE INDEX "offer_history_market_id_offer_id_occurred_at_idx" ON "catalog"."offer_history"("market_id", "offer_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "offer_history_market_id_offer_id_offer_version_key" ON "catalog"."offer_history"("market_id", "offer_id", "offer_version");

-- AddForeignKey
ALTER TABLE "catalog"."offers" ADD CONSTRAINT "offers_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."offer_history" ADD CONSTRAINT "offer_history_market_id_offer_id_fkey" FOREIGN KEY ("market_id", "offer_id") REFERENCES "catalog"."offers"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): docs/design/data/catalog.md sections 2 (CA1, CA3, CA4, CA6),
-- 3.13, 3.14, 5.1, 6.1 (A1, A6, A7, A17, A19), 7 and 8.1 row 5. Every constraint is on a new
-- table. `offers.shelf_category_id` and its same-seller foreign key come in slice 23 (8.1 row 15).
ALTER TABLE "catalog"."offers"
  ADD CONSTRAINT "offers_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offers_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- D 17.1 item 10, CAT-10: 1 to 64 printable ASCII characters, no space or control character.
  ADD CONSTRAINT "offers_seller_sku_check" CHECK ("seller_sku" ~ '^[!-~]{1,64}$'),
  ADD CONSTRAINT "offers_condition_code_check" CHECK ("condition_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offers_description_check" CHECK (jsonb_typeof("description") = 'object'),
  ADD CONSTRAINT "offers_handling_check" CHECK (
    "handling" IS NULL OR "handling" IN ('SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH')),
  -- D 4.4: handling is present from the submit on; only a draft (or a deleted draft) lacks it.
  ADD CONSTRAINT "offers_handling_required_check" CHECK (
    "status" IN ('draft', 'deleted') OR "handling" IS NOT NULL),
  -- B1: the attestation is one statement, recorded with its author, or absent.
  ADD CONSTRAINT "offers_attestation_check" CHECK (
    ("attestation_recorded_at" IS NULL) = ("attestation_account_id" IS NULL)),
  ADD CONSTRAINT "offers_status_check" CHECK ("status" IN
    ('draft', 'pending-first-publish', 'changes-needed', 'published', 'deleted')),
  -- M-5: `listed` is stored for the partial index and one-row reads, and cannot disagree with
  -- the status and the five stored causes.
  ADD CONSTRAINT "offers_listed_check" CHECK ("listed" = (
    "status" = 'published' AND NOT (
      "off_sale_type_not_allowed" OR "off_sale_product_retired" OR "off_sale_product_not_listed"
      OR "off_sale_tag_suspended" OR "off_sale_description_claim_text"))),
  ADD CONSTRAINT "offers_submitted_check" CHECK (
    "status" <> 'pending-first-publish' OR "submitted_at" IS NOT NULL),
  -- Addition to 3.13 (database-designer): a published Offer has been published once.
  ADD CONSTRAINT "offers_first_published_check" CHECK (
    "status" <> 'published' OR "first_published_at" IS NOT NULL),
  ADD CONSTRAINT "offers_deleted_check" CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL)),
  ADD CONSTRAINT "offers_version_check" CHECK ("version" >= 1);

-- Partial indexes (8.4; 6.1 A6, A7, A19). Not CONCURRENTLY: the table is new and empty (8.2).
-- One non-deleted Offer per (Market, seller, product), drafts included (OFR-02, AC 2); the insert's
-- unique violation maps to `offer.exists-for-product`. One non-deleted Offer per SKU and seller
-- (CAT-10). The fan-out keyset, M1 marking, Offers tab and match guard (A7, A12). The Offer half
-- of the review queue (A6): created here with its table rather than in migration 8.
CREATE UNIQUE INDEX "offers_market_id_seller_id_product_id_open_key"
  ON "catalog"."offers" ("market_id", "seller_id", "product_id") WHERE "status" <> 'deleted';
CREATE UNIQUE INDEX "offers_market_id_seller_id_seller_sku_open_key"
  ON "catalog"."offers" ("market_id", "seller_id", "seller_sku") WHERE "status" <> 'deleted';
CREATE INDEX "offers_market_id_product_id_open_idx"
  ON "catalog"."offers" ("market_id", "product_id", "id") WHERE "status" <> 'deleted';
CREATE INDEX "offers_market_id_submitted_at_pending_idx"
  ON "catalog"."offers" ("market_id", "submitted_at", "id") WHERE "status" = 'pending-first-publish';

-- 3.14: the snapshot after the change obeys the rules of the Offer row it copies. The lists are
-- NOT NULL by CHECK (Prisma cannot mark a scalar list required; Mojtaba B1 of slice 4).
ALTER TABLE "catalog"."offer_history"
  ADD CONSTRAINT "offer_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_history_offer_version_check" CHECK ("offer_version" >= 1),
  ADD CONSTRAINT "offer_history_change_kind_check" CHECK ("change_kind" IN (
    'created', 'edited', 'submitted', 'publication-approved', 'changes-requested', 'published',
    'handling-changed', 'attestation-recorded', 'attestation-withdrawn', 'causes-changed', 'moved',
    'shelf-cleared', 'deleted')),
  -- Field ids of D 6.2, no values; may be empty.
  ADD CONSTRAINT "offer_history_changed_fields_check" CHECK (
    "changed_fields" IS NOT NULL AND array_position("changed_fields", NULL) IS NULL
    AND (cardinality("changed_fields") = 0 OR array_to_string("changed_fields", ',')
         ~ '^[a-z][A-Za-z0-9_.-]{0,63}(,[a-z][A-Za-z0-9_.-]{0,63})*$')),
  ADD CONSTRAINT "offer_history_status_check" CHECK ("status" IN
    ('draft', 'pending-first-publish', 'changes-needed', 'published', 'deleted')),
  ADD CONSTRAINT "offer_history_seller_sku_check" CHECK ("seller_sku" ~ '^[!-~]{1,64}$'),
  ADD CONSTRAINT "offer_history_condition_code_check" CHECK ("condition_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "offer_history_description_check" CHECK (jsonb_typeof("description") = 'object'),
  ADD CONSTRAINT "offer_history_handling_check" CHECK (
    "handling" IS NULL OR "handling" IN ('SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH')),
  ADD CONSTRAINT "offer_history_handling_required_check" CHECK (
    "status" IN ('draft', 'deleted') OR "handling" IS NOT NULL),
  ADD CONSTRAINT "offer_history_off_sale_causes_check" CHECK (
    "off_sale_causes" IS NOT NULL AND array_position("off_sale_causes", NULL) IS NULL
    AND "off_sale_causes" <@ ARRAY['type-not-allowed', 'product-retired', 'product-not-listed',
      'tag-suspended', 'description-claim-text']::text[]),
  ADD CONSTRAINT "offer_history_listed_check" CHECK (
    "listed" = ("status" = 'published' AND cardinality("off_sale_causes") = 0)),
  ADD CONSTRAINT "offer_history_actor_kind_check" CHECK ("actor_kind" IN ('seller', 'admin', 'system')),
  ADD CONSTRAINT "offer_history_actor_account_check" CHECK (
    ("actor_kind" = 'system') = ("actor_account_id" IS NULL)),
  ADD CONSTRAINT "offer_history_acting_admin_check" CHECK (
    "acting_admin_account_id" IS NULL OR "actor_kind" = 'seller');

-- CA3 (data design 5.1): the Offer history is insert-only for every role, the owner included,
-- row and statement level.
CREATE TRIGGER "offer_history_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."offer_history"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "offer_history_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (database-designer): docs/design/data/catalog.md section 7. No DELETE on offers (Q-K2:
-- a discarded draft's Offer becomes `deleted`); `id`, `market_id`, `tenant_id`, `seller_id` and
-- `created_at` are never updated (PRC 2.3). The history takes SELECT and INSERT only.
GRANT SELECT, INSERT, UPDATE ("product_id", "seller_sku", "condition_code", "description", "handling",
  "attestation_recorded_at", "attestation_account_id", "status", "off_sale_type_not_allowed",
  "off_sale_product_retired", "off_sale_product_not_listed", "off_sale_tag_suspended",
  "off_sale_description_claim_text", "listed", "submitted_at", "first_published_at", "deleted_at",
  "version")
  ON TABLE "catalog"."offers" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."offer_history" TO "mondapac_app";
