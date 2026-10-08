-- Reverses 20261008120933_platform_audit_seal (docs/design/data/platform.md 11.10): grants first, then the
-- triggers and tables, the function, the audit_log CHECKs, and last the index swap (the unique index
-- can go only after the foreign key that depends on it). Fails once an ANONYMOUS row exists, which is
-- correct (identity data 8.2).
REVOKE SELECT, INSERT ON TABLE "platform"."audit_chain_checkpoint" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "platform"."audit_log_seal" FROM "mondapac_app";
DROP TRIGGER "audit_chain_checkpoint_no_truncate" ON "platform"."audit_chain_checkpoint";
DROP TRIGGER "audit_chain_checkpoint_no_update_delete" ON "platform"."audit_chain_checkpoint";
DROP TRIGGER "audit_log_seal_no_truncate" ON "platform"."audit_log_seal";
DROP TRIGGER "audit_log_seal_no_update_delete" ON "platform"."audit_log_seal";
DROP TABLE "platform"."audit_chain_checkpoint";
DROP TABLE "platform"."audit_log_seal";
DROP FUNCTION "platform"."audit_chain_reject_mutation"();
ALTER TABLE "platform"."audit_log"
  DROP CONSTRAINT "audit_log_after_size_check",
  DROP CONSTRAINT "audit_log_before_size_check",
  DROP CONSTRAINT "audit_log_occurred_at_check",
  DROP CONSTRAINT "audit_log_actor_type_check",
  ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM'));
DROP INDEX "platform"."audit_log_market_id_occurred_at_id_key";
CREATE INDEX "audit_log_market_id_occurred_at_id_idx" ON "platform"."audit_log"("market_id", "occurred_at", "id");
