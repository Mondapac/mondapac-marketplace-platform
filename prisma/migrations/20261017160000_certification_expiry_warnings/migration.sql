-- Certification slice 9, the expiry and warning job (data design 3.18; D 8.6; AC 9): one marker
-- per (approved submission or manufacturer revision, warning threshold), written by the job in
-- the root's unit together with the warning event, so a re-run or a concurrent worker creates
-- nothing. Insert-only. The job's selection uses the existing partial index A9
-- (`seller_certifications_market_id_approved_boundary_at_idx`, migration 1).

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "certification"."expiry_warnings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version_kind" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "threshold_days" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expiry_warnings_pkey" PRIMARY KEY ("market_id","version_kind","version_id","threshold_days")
);

-- Hand-written CHECKs (data design 3.18; S4, S8).
ALTER TABLE "certification"."expiry_warnings"
  ADD CONSTRAINT "expiry_warnings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "expiry_warnings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "expiry_warnings_version_kind_check" CHECK (
    "version_kind" IN ('submission', 'product-revision')),
  ADD CONSTRAINT "expiry_warnings_threshold_days_check" CHECK (
    "threshold_days" BETWEEN 1 AND 366);

-- Insert-only (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "expiry_warnings_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."expiry_warnings"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "expiry_warnings_no_truncate"
  BEFORE TRUNCATE ON "certification"."expiry_warnings"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. Kept (data design 10).
GRANT SELECT, INSERT ON TABLE "certification"."expiry_warnings" TO "mondapac_app";
