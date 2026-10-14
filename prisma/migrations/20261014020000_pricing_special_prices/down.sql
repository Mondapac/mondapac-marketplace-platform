-- Reverses 20261014020000_pricing_special_prices: the grant, the triggers, the table (its
-- CHECKs, the EXCLUDE, indexes and foreign keys go with it), then the function.
REVOKE SELECT, INSERT, UPDATE ("status", "effective_from", "withdrawn_at", "withdraw_cause",
  "decided_at", "decided_by_account_id", "decision_reason_code", "decision_note", "superseded_at",
  "superseded_by_record_id", "supersede_cause")
  ON TABLE "pricing"."special_price_records" FROM "mondapac_app";

DROP TRIGGER "special_price_records_no_truncate" ON "pricing"."special_price_records";
DROP TRIGGER "special_price_records_no_delete" ON "pricing"."special_price_records";
DROP TRIGGER "special_price_records_write_once" ON "pricing"."special_price_records";

DROP TABLE "pricing"."special_price_records";

DROP FUNCTION "pricing"."special_price_records_guard_update"();
