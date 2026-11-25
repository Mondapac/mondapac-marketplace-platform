-- Risk-based Offer approval, slice 4 (ADR-0051 decision 4): probation and Trusted (catalog), the
-- category Offer review flags R7 and R0 (catalog), the seller Offer review flags SEL-25 (sellers),
-- and the reason `sensitive-category` on held edits. New tables are empty; no backfill. The three
-- seller columns have a constant default (metadata-only ADD COLUMN); seller_admin_settings and
-- offer_pending_changes are small, so their CHECKs are added valid in one short lock.
-- Lock order of the units: the Offer row, then the standing row; bulk units lock sellers in id order.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "sellers"."seller_admin_settings" ADD COLUMN     "offer_review_full_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offer_review_full_review_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "offer_review_full_review_changed_by_account_id" UUID,
ADD COLUMN     "offer_review_stop" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offer_review_stop_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "offer_review_stop_changed_by_account_id" UUID,
ADD COLUMN     "offer_review_trusted_from_start" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offer_review_trusted_from_start_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "offer_review_trusted_from_start_changed_by_account_id" UUID;

-- CreateTable
CREATE TABLE "catalog"."seller_review_standings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "target_kind" TEXT NOT NULL,
    "consecutive_changes_needed" INTEGER NOT NULL,
    "trusted_at" TIMESTAMPTZ(6),
    "trust_lost_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_review_standings_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateTable
CREATE TABLE "catalog"."seller_review_credits" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "credited_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_review_credits_pkey" PRIMARY KEY ("market_id","seller_id","epoch","product_id")
);

-- CreateTable
CREATE TABLE "catalog"."category_offer_review_flags" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "always_review" BOOLEAN NOT NULL,
    "always_review_changed_at" TIMESTAMPTZ(6),
    "always_review_changed_by_account_id" UUID,
    "review_stop" BOOLEAN NOT NULL,
    "review_stop_changed_at" TIMESTAMPTZ(6),
    "review_stop_changed_by_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_offer_review_flags_pkey" PRIMARY KEY ("market_id","category_id")
);

-- CreateTable
CREATE TABLE "catalog"."category_offer_review_changes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "flag" TEXT NOT NULL,
    "previous_value" BOOLEAN NOT NULL,
    "new_value" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_account_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_offer_review_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sellers"."offer_review_flag_changes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "flag" TEXT NOT NULL,
    "previous_value" BOOLEAN NOT NULL,
    "new_value" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_account_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_review_flag_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_offer_review_changes_category_idx" ON "catalog"."category_offer_review_changes"("market_id", "category_id", "changed_at", "id");

-- CreateIndex
CREATE INDEX "offer_review_flag_changes_seller_idx" ON "sellers"."offer_review_flag_changes"("market_id", "seller_id", "changed_at", "id");

-- AddForeignKey
ALTER TABLE "catalog"."seller_review_credits" ADD CONSTRAINT "seller_review_credits_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "catalog"."seller_review_standings"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."seller_review_credits" ADD CONSTRAINT "seller_review_credits_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."seller_review_credits" ADD CONSTRAINT "seller_review_credits_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_offer_review_flags" ADD CONSTRAINT "category_offer_review_flags_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."platform_categories"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."category_offer_review_changes" ADD CONSTRAINT "category_offer_review_changes_market_id_category_id_fkey" FOREIGN KEY ("market_id", "category_id") REFERENCES "catalog"."category_offer_review_flags"("market_id", "category_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."offer_review_flag_changes" ADD CONSTRAINT "offer_review_flag_changes_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): CHECKs, guards and grants.

-- seller_admin_settings: each switch's changed at/by go together, and a switch that is on was
-- changed by someone (rows start off).
ALTER TABLE "sellers"."seller_admin_settings"
  ADD CONSTRAINT "seller_admin_settings_offer_review_trusted_changed_check" CHECK (
    ("offer_review_trusted_from_start_changed_at" IS NULL) = ("offer_review_trusted_from_start_changed_by_account_id" IS NULL)
    AND (NOT "offer_review_trusted_from_start" OR "offer_review_trusted_from_start_changed_at" IS NOT NULL)),
  ADD CONSTRAINT "seller_admin_settings_offer_review_full_review_changed_check" CHECK (
    ("offer_review_full_review_changed_at" IS NULL) = ("offer_review_full_review_changed_by_account_id" IS NULL)
    AND (NOT "offer_review_full_review" OR "offer_review_full_review_changed_at" IS NOT NULL)),
  ADD CONSTRAINT "seller_admin_settings_offer_review_stop_changed_check" CHECK (
    ("offer_review_stop_changed_at" IS NULL) = ("offer_review_stop_changed_by_account_id" IS NULL)
    AND (NOT "offer_review_stop" OR "offer_review_stop_changed_at" IS NOT NULL));

-- sellers.offer_review_flag_changes: insert-only (grants plus the guard below).
ALTER TABLE "sellers"."offer_review_flag_changes"
  ADD CONSTRAINT "offer_review_flag_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_review_flag_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_review_flag_changes_flag_check" CHECK (
    "flag" IN ('trusted-from-start', 'full-review', 'review-stop')),
  ADD CONSTRAINT "offer_review_flag_changes_value_check" CHECK ("previous_value" <> "new_value"),
  ADD CONSTRAINT "offer_review_flag_changes_reason_check" CHECK (
    "reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 500);

-- Data design 5.1 rules (SECURITY INVOKER, pinned path): never updated or deleted; changed_at is now.
CREATE FUNCTION "sellers"."offer_review_flag_changes_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'sellers.offer_review_flag_changes: append-only, % is not allowed', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.changed_at < statement_timestamp() - interval '5 minutes'
     OR NEW.changed_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'sellers.offer_review_flag_changes: changed_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_review_flag_changes_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "sellers"."offer_review_flag_changes"
  FOR EACH ROW EXECUTE FUNCTION "sellers"."offer_review_flag_changes_guard"();
CREATE TRIGGER "offer_review_flag_changes_no_truncate" BEFORE TRUNCATE
  ON "sellers"."offer_review_flag_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION "sellers"."offer_review_flag_changes_guard"();

-- catalog.seller_review_standings.
ALTER TABLE "catalog"."seller_review_standings"
  ADD CONSTRAINT "seller_review_standings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_review_standings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_review_standings_epoch_check" CHECK ("epoch" >= 1),
  ADD CONSTRAINT "seller_review_standings_target_kind_check" CHECK ("target_kind" IN ('initial', 'after-misconduct')),
  -- after-misconduct exists only after a revocation, which opened a new epoch.
  ADD CONSTRAINT "seller_review_standings_after_misconduct_check" CHECK (
    "target_kind" = 'initial' OR ("trust_lost_at" IS NOT NULL AND "epoch" >= 2)),
  -- The second Changes needed in a row restarts the epoch and resets the count to 0.
  ADD CONSTRAINT "seller_review_standings_consecutive_changes_needed_check" CHECK (
    "consecutive_changes_needed" BETWEEN 0 AND 1),
  -- Changes needed are counted only in probation; reaching the target resets them.
  ADD CONSTRAINT "seller_review_standings_trusted_check" CHECK (
    "trusted_at" IS NULL OR "consecutive_changes_needed" = 0),
  ADD CONSTRAINT "seller_review_standings_trusted_after_loss_check" CHECK (
    "trusted_at" IS NULL OR "trust_lost_at" IS NULL OR "trusted_at" > "trust_lost_at"),
  ADD CONSTRAINT "seller_review_standings_times_check" CHECK (
    "updated_at" >= "created_at"
    AND ("trusted_at" IS NULL OR "trusted_at" >= "created_at")
    AND ("trust_lost_at" IS NULL OR "trust_lost_at" >= "created_at")),
  ADD CONSTRAINT "seller_review_standings_version_check" CHECK ("version" >= 1);

-- Never deleted; identity never changes; version +1 per write; the epoch only moves forward by one,
-- and a new epoch starts in probation with no pending Changes needed. trusted_at is stamped once per
-- epoch and cleared only by a misconduct revocation, which is the only move to after-misconduct
-- and the only writer of trust_lost_at.
CREATE FUNCTION "catalog"."seller_review_standings_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE revoked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.updated_at < statement_timestamp() - interval '5 minutes'
     OR NEW.updated_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: updated_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (NEW.market_id, NEW.tenant_id, NEW.seller_id, NEW.created_at)
     IS DISTINCT FROM (OLD.market_id, OLD.tenant_id, OLD.seller_id, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: version must rise by one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.epoch NOT IN (OLD.epoch, OLD.epoch + 1) THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: epoch moves forward by one' USING ERRCODE = 'check_violation';
  END IF;
  revoked := NEW.trust_lost_at IS DISTINCT FROM OLD.trust_lost_at;
  IF revoked AND (NEW.trust_lost_at IS NULL OR NEW.trust_lost_at <= OLD.trust_lost_at
                  OR NEW.epoch = OLD.epoch OR NEW.target_kind <> 'after-misconduct') THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: a revocation opens an after-misconduct epoch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_kind <> OLD.target_kind AND NOT revoked THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: target_kind changes only on a revocation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.epoch <> OLD.epoch AND (NEW.trusted_at IS NOT NULL OR NEW.consecutive_changes_needed <> 0) THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: a new epoch starts in probation' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.trusted_at IS NOT NULL AND NEW.trusted_at IS DISTINCT FROM OLD.trusted_at AND NOT revoked THEN
    RAISE EXCEPTION 'catalog.seller_review_standings: trusted_at is cleared only by a revocation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "seller_review_standings_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."seller_review_standings"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."seller_review_standings_guard"();
CREATE TRIGGER "seller_review_standings_no_truncate" BEFORE TRUNCATE
  ON "catalog"."seller_review_standings"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- catalog.seller_review_credits: insert-only; a credit counts in the standing's current epoch.
ALTER TABLE "catalog"."seller_review_credits"
  ADD CONSTRAINT "seller_review_credits_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_review_credits_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_review_credits_epoch_check" CHECK ("epoch" >= 1);

-- The unit already holds the standing row FOR UPDATE (lock order: Offer, then standing).
CREATE FUNCTION "catalog"."seller_review_credits_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_epoch integer;
BEGIN
  IF NEW.credited_at < statement_timestamp() - interval '5 minutes'
     OR NEW.credited_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.seller_review_credits: credited_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.epoch INTO current_epoch FROM "catalog"."seller_review_standings" s
   WHERE s.market_id = NEW.market_id AND s.seller_id = NEW.seller_id;
  IF current_epoch IS DISTINCT FROM NEW.epoch THEN
    RAISE EXCEPTION 'catalog.seller_review_credits: a credit is in the current epoch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "seller_review_credits_guard" BEFORE INSERT
  ON "catalog"."seller_review_credits"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."seller_review_credits_guard"();
CREATE TRIGGER "seller_review_credits_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."seller_review_credits"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "seller_review_credits_no_truncate" BEFORE TRUNCATE
  ON "catalog"."seller_review_credits"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- catalog.category_offer_review_flags.
ALTER TABLE "catalog"."category_offer_review_flags"
  ADD CONSTRAINT "category_offer_review_flags_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_offer_review_flags_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_offer_review_flags_always_review_changed_check" CHECK (
    ("always_review_changed_at" IS NULL) = ("always_review_changed_by_account_id" IS NULL)
    AND (NOT "always_review" OR "always_review_changed_at" IS NOT NULL)),
  ADD CONSTRAINT "category_offer_review_flags_review_stop_changed_check" CHECK (
    ("review_stop_changed_at" IS NULL) = ("review_stop_changed_by_account_id" IS NULL)
    AND (NOT "review_stop" OR "review_stop_changed_at" IS NOT NULL)),
  -- The row is created by the first flag change.
  ADD CONSTRAINT "category_offer_review_flags_created_check" CHECK (
    "always_review_changed_at" IS NOT NULL OR "review_stop_changed_at" IS NOT NULL),
  ADD CONSTRAINT "category_offer_review_flags_version_check" CHECK ("version" >= 1);

-- Never deleted; identity never changes; version +1 per write.
CREATE FUNCTION "catalog"."category_offer_review_flags_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.category_offer_review_flags: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.market_id, NEW.tenant_id, NEW.category_id, NEW.created_at)
     IS DISTINCT FROM (OLD.market_id, OLD.tenant_id, OLD.category_id, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.category_offer_review_flags: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.category_offer_review_flags: version must rise by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "category_offer_review_flags_guard" BEFORE UPDATE OR DELETE
  ON "catalog"."category_offer_review_flags"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."category_offer_review_flags_guard"();
CREATE TRIGGER "category_offer_review_flags_no_truncate" BEFORE TRUNCATE
  ON "catalog"."category_offer_review_flags"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- catalog.category_offer_review_changes: insert-only.
ALTER TABLE "catalog"."category_offer_review_changes"
  ADD CONSTRAINT "category_offer_review_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "category_offer_review_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "category_offer_review_changes_flag_check" CHECK ("flag" IN ('always-review', 'review-stop')),
  ADD CONSTRAINT "category_offer_review_changes_value_check" CHECK ("previous_value" <> "new_value"),
  ADD CONSTRAINT "category_offer_review_changes_reason_check" CHECK (
    "reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 500);

CREATE FUNCTION "catalog"."category_offer_review_changes_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.changed_at < statement_timestamp() - interval '5 minutes'
     OR NEW.changed_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.category_offer_review_changes: changed_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "category_offer_review_changes_guard" BEFORE INSERT
  ON "catalog"."category_offer_review_changes"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."category_offer_review_changes_guard"();
CREATE TRIGGER "category_offer_review_changes_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."category_offer_review_changes"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "category_offer_review_changes_no_truncate" BEFORE TRUNCATE
  ON "catalog"."category_offer_review_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- R7 on watched edits (owner answer 4): a held change may carry `sensitive-category`.
ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_reasons_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 6
    AND "reasons" <@ ARRAY['emergency-stop', 'certificate-badge', 'handling', 'contact-text',
      'sensitive-category', 'review-all']::text[]);

-- Grants (least privilege). seller_admin_settings keeps its table-level grant.
GRANT SELECT, INSERT ON TABLE "sellers"."offer_review_flag_changes" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."seller_review_standings" TO "mondapac_app";
GRANT UPDATE ("epoch", "target_kind", "consecutive_changes_needed", "trusted_at", "trust_lost_at",
  "version", "updated_at") ON TABLE "catalog"."seller_review_standings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."seller_review_credits" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."category_offer_review_flags" TO "mondapac_app";
GRANT UPDATE ("always_review", "always_review_changed_at", "always_review_changed_by_account_id",
  "review_stop", "review_stop_changed_at", "review_stop_changed_by_account_id", "version")
  ON TABLE "catalog"."category_offer_review_flags" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."category_offer_review_changes" TO "mondapac_app";
