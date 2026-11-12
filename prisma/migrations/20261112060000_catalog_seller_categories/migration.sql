SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Categories package C9a (catalog design 4.7, CAT-51..54; data design 3.13 and 3.22): seller
-- shelves, their names, seller category proposals and the same-seller shelf column of offers.
-- CreateTable
CREATE TABLE "catalog"."seller_categories" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "platform_parent_id" UUID NOT NULL,
    "slug" TEXT COLLATE "C" NOT NULL,
    "status" TEXT NOT NULL,
    "merged_into_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_categories_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "catalog"."seller_category_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "seller_category_names_pkey" PRIMARY KEY ("market_id","category_id","locale")
);

-- CreateTable
CREATE TABLE "catalog"."category_proposals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "platform_parent_id" UUID NOT NULL,
    "names" JSONB NOT NULL,
    "descriptions" JSONB,
    "normalised_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason_code" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_seller_category_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_proposals_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE INDEX "seller_categories_market_id_platform_parent_id_idx" ON "catalog"."seller_categories"("market_id", "platform_parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_categories_market_id_id_seller_id_key" ON "catalog"."seller_categories"("market_id", "id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_categories_market_id_seller_id_slug_key" ON "catalog"."seller_categories"("market_id", "seller_id", "slug");

-- AddForeignKey
ALTER TABLE "catalog"."seller_categories" ADD CONSTRAINT "seller_categories_market_id_platform_parent_id_fkey" FOREIGN KEY ("market_id", "platform_parent_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."seller_categories" ADD CONSTRAINT "seller_categories_market_id_merged_into_id_fkey" FOREIGN KEY ("market_id", "merged_into_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."seller_category_names" ADD CONSTRAINT "seller_category_names_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."seller_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_proposals" ADD CONSTRAINT "category_proposals_market_id_platform_parent_id_fkey" FOREIGN KEY ("market_id", "platform_parent_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_proposals" ADD CONSTRAINT "category_proposals_market_id_created_seller_category_id_se_fkey" FOREIGN KEY ("market_id", "created_seller_category_id", "seller_id") REFERENCES "catalog"."seller_categories"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): data design 3.22 and 3.13.

ALTER TABLE "catalog"."seller_categories"
  ADD CONSTRAINT "seller_categories_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_categories_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_categories_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 80),
  ADD CONSTRAINT "seller_categories_status_check" CHECK (
    "status" IN ('active', 'promoted', 'merged', 'archived')),
  ADD CONSTRAINT "seller_categories_merged_check" CHECK (
    ("status" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "seller_categories_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."seller_category_names"
  ADD CONSTRAINT "seller_category_names_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_category_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_category_names_locale_check" CHECK (
    "locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
  -- CA5: the S7 class (no control or bidi characters), trimmed; ZWNJ and ZWJ stay allowed.
  ADD CONSTRAINT "seller_category_names_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  -- A description may hold line breaks (LF), never another control or bidi character.
  ADD CONSTRAINT "seller_category_names_description_check" CHECK (
    "description" IS NULL OR (char_length("description") BETWEEN 1 AND 1000
      AND "description" = btrim("description")
      AND "description" !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'));

ALTER TABLE "catalog"."category_proposals"
  ADD CONSTRAINT "category_proposals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_proposals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_proposals_names_check" CHECK (
    jsonb_typeof("names") = 'object' AND "names" <> '{}'::jsonb),
  ADD CONSTRAINT "category_proposals_descriptions_check" CHECK (
    "descriptions" IS NULL OR jsonb_typeof("descriptions") = 'object'),
  -- A backstop against a bypassed validator (the V6 precedent, Mojtaba N5).
  ADD CONSTRAINT "category_proposals_names_size_check" CHECK (pg_column_size("names") <= 16384),
  ADD CONSTRAINT "category_proposals_descriptions_size_check" CHECK (
    "descriptions" IS NULL OR pg_column_size("descriptions") <= 65536),
  ADD CONSTRAINT "category_proposals_normalised_name_check" CHECK (
    char_length("normalised_name") BETWEEN 1 AND 120),
  ADD CONSTRAINT "category_proposals_status_check" CHECK (
    "status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Prepared reasons only (FP8 row 4): never free text, so no seller or admin words reach a log.
  ADD CONSTRAINT "category_proposals_reason_code_check" CHECK (
    ("status" IN ('pending', 'approved') AND "reason_code" IS NULL)
    OR ("status" = 'rejected' AND "reason_code" IN (
      'already-exists', 'too-narrow', 'too-broad', 'misleading', 'not-sold-here', 'other'))
    OR ("status" = 'cancelled' AND "reason_code" IN ('seller-cancelled', 'permission-revoked'))),
  ADD CONSTRAINT "category_proposals_decided_check" CHECK (
    ("status" = 'pending') = ("decided_at" IS NULL)),
  -- An admin decides an approval or a rejection; a cancellation is the seller's or the system's.
  ADD CONSTRAINT "category_proposals_decided_by_check" CHECK (
    ("status" IN ('approved', 'rejected')) = ("decided_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "category_proposals_created_check" CHECK (
    ("status" = 'approved') = ("created_seller_category_id" IS NOT NULL)),
  ADD CONSTRAINT "category_proposals_version_check" CHECK ("version" >= 1);

-- One waiting proposal per (seller, parent, normalised name) (C9 brief; amendments C9).
CREATE UNIQUE INDEX "category_proposals_pending_name_key"
  ON "catalog"."category_proposals" ("market_id", "seller_id", "platform_parent_id", "normalised_name")
  WHERE "status" = 'pending';
-- The pending name key leads with (market, seller) under the same predicate, so it also serves
-- the CAT-54 cap count and the revocation handler (Mojtaba N2): no second index.
-- The admin tab, oldest first.
CREATE INDEX "category_proposals_market_id_created_at_pending_idx"
  ON "catalog"."category_proposals" ("market_id", "created_at", "id") WHERE "status" = 'pending';
-- The seller's own list, newest first: a backward scan with no tie sort (Mojtaba N3).
CREATE INDEX "category_proposals_market_id_seller_id_created_at_id_idx"
  ON "catalog"."category_proposals" ("market_id", "seller_id", "created_at", "id");
-- The index of offers.shelf_category_id is built CONCURRENTLY in 20261112060002, alone in its
-- file (data design 8.2).

-- A proposal is born pending at version 1 and decided once; nothing about it but the decision
-- ever changes, and it is never deleted. Data design 5.1 rules (SECURITY INVOKER, pinned path).
CREATE FUNCTION "catalog"."category_proposals_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.category_proposals: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'catalog.category_proposals: a new proposal is pending at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.seller_id, NEW.platform_parent_id, NEW.names,
      NEW.descriptions, NEW.normalised_name, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.seller_id, OLD.platform_parent_id, OLD.names,
      OLD.descriptions, OLD.normalised_name, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.category_proposals: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'catalog.category_proposals: only a pending proposal is decided, once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.category_proposals: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "category_proposals_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."category_proposals"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."category_proposals_guard"();
CREATE TRIGGER "category_proposals_no_truncate" BEFORE TRUNCATE
  ON "catalog"."category_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- A shelf is born active at version 1; only an active shelf changes, once, to promoted, merged or
-- archived (all terminal). Seller, parent and slug never change; it is never deleted.
CREATE FUNCTION "catalog"."seller_categories_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.seller_categories: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'catalog.seller_categories: a new shelf is active at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.seller_id, NEW.platform_parent_id, NEW.slug, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.seller_id, OLD.platform_parent_id, OLD.slug, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.seller_categories: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'catalog.seller_categories: a closed shelf never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.seller_categories: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "seller_categories_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."seller_categories"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."seller_categories_guard"();
CREATE TRIGGER "seller_categories_no_truncate" BEFORE TRUNCATE
  ON "catalog"."seller_categories"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- The proposal rate counter (D 8.4): proposals per seller per day, on top of the pending cap.
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day',
    'seller-import-check.seller.hour', 'seller-import-check.seller.day',
    'import-photo.seller.minute', 'import-photo.seller.day', 'add-sizes.account.hour',
    'category-propose.seller.day'));

-- Grants (data design 7): only the decision moves on a proposal; only status, the merge target
-- and the version on a shelf; a shelf's names are written once with it (no use case changes or
-- removes one: Hassan, Mojtaba N4).
GRANT SELECT, INSERT, UPDATE ("status", "reason_code", "decided_by_account_id", "decided_at",
  "created_seller_category_id", "version")
  ON TABLE "catalog"."category_proposals" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "merged_into_id", "version")
  ON TABLE "catalog"."seller_categories" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."seller_category_names" TO "mondapac_app";

-- The shelf column of offers, last, so the ACCESS EXCLUSIVE lock of offers is held for the
-- shortest time: ADD COLUMN with no default and the key NOT VALID read no rows. The key is
-- validated in 20261112060001 under SHARE UPDATE EXCLUSIVE, which lets reads and writes run.
-- AlterTable
ALTER TABLE "catalog"."offers" ADD COLUMN     "shelf_category_id" UUID;

-- AddForeignKey
ALTER TABLE "catalog"."offers" ADD CONSTRAINT "offers_market_id_shelf_category_id_seller_id_fkey" FOREIGN KEY ("market_id", "shelf_category_id", "seller_id") REFERENCES "catalog"."seller_categories"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

GRANT UPDATE ("shelf_category_id") ON TABLE "catalog"."offers" TO "mondapac_app";
