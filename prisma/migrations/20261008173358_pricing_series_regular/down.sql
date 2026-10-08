-- Reverses 20261008173358_pricing_series_regular (docs/design/data/pricing.md 8.2): the grants
-- first, in reverse order, then the triggers, then the tables, children before parents (CHECKs,
-- the EXCLUDE, indexes and foreign keys go with their tables), then the functions, then the schema
-- USAGE. The empty schema "pricing" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects. The btree_gist extension is not this
-- migration's and stays.
REVOKE SELECT, INSERT, UPDATE ("window_started_at", "recorded_count", "suppressed_count"), DELETE
  ON TABLE "pricing"."write_refusal_actor_throttles" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("window_started_at"), DELETE
  ON TABLE "pricing"."write_refusal_throttles" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "pricing"."retired_variants" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "pricing"."retired_offers" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "effective_from", "effective_to", "decided_at",
  "decided_by_account_id", "decision_reason_code", "decision_note", "superseded_at",
  "superseded_by_record_id", "supersede_cause")
  ON TABLE "pricing"."regular_price_records" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("retired_at", "retire_cause", "version")
  ON TABLE "pricing"."price_series" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "pricing"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "pricing"."outbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "pricing" FROM "mondapac_app";

DROP TRIGGER "regular_price_records_no_truncate" ON "pricing"."regular_price_records";
DROP TRIGGER "regular_price_records_no_delete" ON "pricing"."regular_price_records";
DROP TRIGGER "regular_price_records_write_once" ON "pricing"."regular_price_records";

DROP TABLE "pricing"."write_refusal_actor_throttles";
DROP TABLE "pricing"."write_refusal_throttles";
DROP TABLE "pricing"."retired_variants";
DROP TABLE "pricing"."retired_offers";
DROP TABLE "pricing"."regular_price_records";
DROP TABLE "pricing"."price_series";
DROP TABLE "pricing"."inbox";
DROP TABLE "pricing"."outbox";

DROP FUNCTION "pricing"."regular_price_records_guard_update"();
DROP FUNCTION "pricing"."reject_mutation"();
