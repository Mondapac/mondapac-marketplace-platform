-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateTable
CREATE TABLE "platform"."audit_log" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "acting_as_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_market_id_target_type_target_id_occurred_at_idx" ON "platform"."audit_log"("market_id", "target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_market_id_actor_id_occurred_at_idx" ON "platform"."audit_log"("market_id", "actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_market_id_occurred_at_id_idx" ON "platform"."audit_log"("market_id", "occurred_at", "id");

-- Hand-written (database-designer): integrity backstops Prisma cannot express.
ALTER TABLE "platform"."audit_log"
  ADD CONSTRAINT "audit_log_market_id_check" CHECK ("market_id" <> ''),
  ADD CONSTRAINT "audit_log_tenant_id_check" CHECK ("tenant_id" <> ''),
  ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM')),
  ADD CONSTRAINT "audit_log_actor_check" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)),
  ADD CONSTRAINT "audit_log_acting_as_check" CHECK ("acting_as_id" IS NULL OR ("actor_id" IS NOT NULL AND "acting_as_id" <> "actor_id")),
  ADD CONSTRAINT "audit_log_action_check" CHECK ("action" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("action") <= 128),
  ADD CONSTRAINT "audit_log_target_type_check" CHECK ("target_type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("target_type") <= 128),
  ADD CONSTRAINT "audit_log_target_id_check" CHECK (char_length("target_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "audit_log_before_check" CHECK ("before" IS NULL OR jsonb_typeof("before") = 'object'),
  ADD CONSTRAINT "audit_log_after_check" CHECK ("after" IS NULL OR jsonb_typeof("after") = 'object'),
  ADD CONSTRAINT "audit_log_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

-- Hand-written (database-designer): append-only enforcement (ADR-0004 decision 7, ADR-0009 V4).
CREATE FUNCTION "platform"."audit_log_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform.audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_log_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_log_reject_mutation"();

CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_log_reject_mutation"();
