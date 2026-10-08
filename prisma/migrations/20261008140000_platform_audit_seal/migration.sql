-- DropIndex
DROP INDEX "platform"."audit_log_market_id_occurred_at_id_idx";

-- CreateTable
CREATE TABLE "platform"."audit_log_seal" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "chain_seq" BIGINT NOT NULL,
    "audit_log_id" UUID NOT NULL,
    "audit_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "row_hash" BYTEA NOT NULL,
    "chain_hash" BYTEA NOT NULL,
    "late" BOOLEAN NOT NULL,
    "hash_version" SMALLINT NOT NULL,
    "sealed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_log_seal_pkey" PRIMARY KEY ("market_id","epoch","chain_seq")
);

-- CreateTable
CREATE TABLE "platform"."audit_chain_checkpoint" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "chain_seq" BIGINT NOT NULL,
    "chain_hash" BYTEA NOT NULL,
    "hash_version" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_chain_checkpoint_pkey" PRIMARY KEY ("market_id","epoch","chain_seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seal_market_id_epoch_occurred_at_id_key" ON "platform"."audit_log_seal"("market_id", "epoch", "audit_occurred_at", "audit_log_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_market_id_occurred_at_id_key" ON "platform"."audit_log"("market_id", "occurred_at", "id");

-- AddForeignKey
ALTER TABLE "platform"."audit_log_seal" ADD CONSTRAINT "audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey" FOREIGN KEY ("market_id", "audit_occurred_at", "audit_log_id") REFERENCES "platform"."audit_log"("market_id", "occurred_at", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/platform.md 11.2 and identity.md 6. The table is
-- empty in every database: no audit writer exists before this slice.
ALTER TABLE "platform"."audit_log"
  DROP CONSTRAINT "audit_log_actor_type_check",
  ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  ADD CONSTRAINT "audit_log_occurred_at_check" CHECK ("occurred_at" = date_trunc('milliseconds', "occurred_at", 'UTC')),
  ADD CONSTRAINT "audit_log_before_size_check" CHECK (octet_length("before"::text) <= 8192),
  ADD CONSTRAINT "audit_log_after_size_check" CHECK (octet_length("after"::text) <= 8192);

-- Hand-written (database-designer): docs/design/data/platform.md 11.3 and 11.4.
ALTER TABLE "platform"."audit_log_seal"
  ADD CONSTRAINT "audit_log_seal_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "audit_log_seal_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "audit_log_seal_epoch_check" CHECK ("epoch" >= 1),
  ADD CONSTRAINT "audit_log_seal_chain_seq_check" CHECK ("chain_seq" >= 1),
  ADD CONSTRAINT "audit_log_seal_genesis_check" CHECK ("epoch" > 1 OR "chain_seq" > 1 OR NOT "late"),
  ADD CONSTRAINT "audit_log_seal_row_hash_check" CHECK (octet_length("row_hash") = 32),
  ADD CONSTRAINT "audit_log_seal_chain_hash_check" CHECK (octet_length("chain_hash") = 32),
  ADD CONSTRAINT "audit_log_seal_hash_version_check" CHECK ("hash_version" IN (1));

ALTER TABLE "platform"."audit_chain_checkpoint"
  ADD CONSTRAINT "audit_chain_checkpoint_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "audit_chain_checkpoint_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "audit_chain_checkpoint_epoch_check" CHECK ("epoch" >= 1),
  ADD CONSTRAINT "audit_chain_checkpoint_chain_seq_check" CHECK ("chain_seq" >= 1),
  ADD CONSTRAINT "audit_chain_checkpoint_chain_hash_check" CHECK (octet_length("chain_hash") = 32),
  ADD CONSTRAINT "audit_chain_checkpoint_hash_version_check" CHECK ("hash_version" IN (1));

-- Hand-written (database-designer): append-only enforcement for the seal and the checkpoints
-- (ADR-0004 decision 7, ADR-0009 V4; docs/design/data/platform.md 11.5).
CREATE FUNCTION "platform"."audit_chain_reject_mutation"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_log_seal_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_log_seal"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_log_seal_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_log_seal"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_chain_checkpoint_no_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."audit_chain_checkpoint"
  FOR EACH ROW EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

CREATE TRIGGER "audit_chain_checkpoint_no_truncate"
  BEFORE TRUNCATE ON "platform"."audit_chain_checkpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."audit_chain_reject_mutation"();

-- Grants (database-designer): docs/design/data/platform.md section 11.6.
GRANT SELECT, INSERT ON TABLE "platform"."audit_log_seal" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "platform"."audit_chain_checkpoint" TO "mondapac_app";
